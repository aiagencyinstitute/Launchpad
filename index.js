require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, EmbedBuilder, Events
} = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCurrentWeek() {
  const start = new Date(process.env.COHORT_START_DATE);
  const now = new Date();
  const diff = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(12, diff + 1));
}

// Track who has checked in this week (resets Monday)
// In production you'd use a database; this works for 12-student cohorts
const weeklyCheckins = new Set();
const introPosters = new Set();
const joinTimestamps = new Map();

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ LaunchPad Bot is online as ${client.user.tag}`);
});

// ── New member joins ──────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // 1. Assign student role
    const studentRole = member.guild.roles.cache.get(process.env.STUDENT_ROLE_ID);
    if (studentRole) await member.roles.add(studentRole);

    // 2. Record join time for intro follow-up
    joinTimestamps.set(member.id, Date.now());

    // 3. Welcome DM
    const week = getCurrentWeek();
    await member.send({
      embeds: [new EmbedBuilder()
        .setColor(0x2DD4BF)
        .setTitle(`Welcome to LaunchPad, ${member.displayName}! 🚀`)
        .setDescription(
          `We're so glad you're here. Here's what to do right now:\n\n` +
          `**1.** Head to <#${process.env.CHECKIN_CHANNEL_ID}> and post your intro — your name, your niche idea, and what you want to get out of LaunchPad.\n\n` +
          `**2.** Watch the first module in Kajabi to get started.\n\n` +
          `**3.** Every Monday, type \`/checkin\` in <#${process.env.CHECKIN_CHANNEL_ID}> to report your progress. It takes 2 minutes.\n\n` +
          `**4.** Got a question? Drop it in #questions — don't sit on blockers.\n\n` +
          `We're here to help. Let's build! 💪`
        )
      ]
    });

    // 4. Welcome post in server
    const introChannel = member.guild.channels.cache.find(c => c.name === 'introductions');
    if (introChannel) {
      await introChannel.send(`👋 Welcome to LaunchPad, <@${member.id}>! Head over here and tell us about yourself — your name, what niche you're thinking about, and what you want to achieve. The group wants to meet you!`);
    }

  } catch (err) {
    console.error('Error in GuildMemberAdd:', err);
  }
});

// ── Slash command interactions ────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /checkin ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'checkin') {
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
      console.error('Error in /checkin:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Something went wrong opening the check-in. Try again!', ephemeral: true });
      }
    }
  }

  // ── /win ──────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'win') {
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
      console.error('Error in /win:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Something went wrong. Try again!', ephemeral: true });
      }
    }
  }

  // ── /logoutreach ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'logoutreach') {
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
      console.error('Error in /logoutreach:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Something went wrong. Try again!', ephemeral: true });
      }
    }
  }

  // ── Modal submissions ─────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {

    // Check-in submission
    if (interaction.customId.startsWith('checkin_week_')) {
      const week = parseInt(interaction.customId.split('_')[2]);
      const responses = {};
      for (let i = 1; i <= 5; i++) {
        try { responses[`q${i}`] = interaction.fields.getTextInputValue(`q${i}`); }
        catch { responses[`q${i}`] = ''; }
      }

      const payload = {
        student_name: interaction.user.globalName || interaction.user.username,
        student_discord_id: interaction.user.id,
        week_number: week,
        submitted_at: new Date().toISOString(),
        responses,
      };

      // Send to n8n
      if (process.env.N8N_CHECKIN_WEBHOOK && !process.env.N8N_CHECKIN_WEBHOOK.includes('paste_after')) {
        try { await axios.post(process.env.N8N_CHECKIN_WEBHOOK, payload); }
        catch (err) { console.error('n8n webhook error:', err.message); }
      }

      weeklyCheckins.add(interaction.user.id);

      // Confirm in channel
      const checkinChannel = client.channels.cache.get(process.env.CHECKIN_CHANNEL_ID);
      if (checkinChannel) {
        await checkinChannel.send(`✅ **${interaction.user.globalName || interaction.user.username}** checked in for Week ${week}! Keep it up. 💪`);
      }

      // Check for milestone roles
      await checkMilestones(interaction, week, responses);

      await interaction.reply({ content: `✅ Check-in submitted for Week ${week}! Nice work.`, ephemeral: true });
    }

    // Win submission
    if (interaction.customId === 'win_modal') {
      const winText = interaction.fields.getTextInputValue('win_text');
      const winDetail = interaction.fields.getTextInputValue('win_detail');
      const name = interaction.user.globalName || interaction.user.username;

      const winsChannel = client.channels.cache.get(process.env.WINS_CHANNEL_ID);
      if (winsChannel) {
        await winsChannel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xF97316)
            .setTitle(`🔥 WIN ALERT — ${name}`)
            .setDescription(`**${winText}**${winDetail ? `\n\n${winDetail}` : ''}`)
          ]
        });
      }

      if (process.env.N8N_WIN_WEBHOOK && !process.env.N8N_WIN_WEBHOOK.includes('paste_after')) {
        try {
          await axios.post(process.env.N8N_WIN_WEBHOOK, {
            student_name: name,
            student_discord_id: interaction.user.id,
            win_text: winText,
            win_detail: winDetail,
            submitted_at: new Date().toISOString(),
          });
        } catch (err) { console.error('Win webhook error:', err.message); }
      }

      await interaction.reply({ content: `🔥 Win posted in #wins! Legend.`, ephemeral: true });
    }

    // Outreach submission
    if (interaction.customId === 'outreach_modal') {
      const calls = interaction.fields.getTextInputValue('calls');
      const dms = interaction.fields.getTextInputValue('dms');
      const emails = interaction.fields.getTextInputValue('emails');
      const total = (parseInt(calls) || 0) + (parseInt(dms) || 0) + (parseInt(emails) || 0);
      const name = interaction.user.globalName || interaction.user.username;

      if (process.env.N8N_OUTREACH_WEBHOOK && !process.env.N8N_OUTREACH_WEBHOOK.includes('paste_after')) {
        try {
          await axios.post(process.env.N8N_OUTREACH_WEBHOOK, {
            student_name: name,
            student_discord_id: interaction.user.id,
            calls: parseInt(calls) || 0,
            dms: parseInt(dms) || 0,
            emails: parseInt(emails) || 0,
            total_touches: total,
            submitted_at: new Date().toISOString(),
          });
        } catch (err) { console.error('Outreach webhook error:', err.message); }
      }

      await interaction.reply({
        content: `✅ Logged: ${calls} calls, ${dms} DMs, ${emails} emails. **${total} total touches today.** Keep going!`,
        ephemeral: true
      });
    }
  }
});

// ── Milestone role checker ────────────────────────────────────────────────────
async function checkMilestones(interaction, week, responses) {
  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);
  const allResponses = Object.values(responses).join(' ').toLowerCase();

  const assign = async (roleId, roleName) => {
    const role = guild.roles.cache.get(roleId);
    if (role && !member.roles.cache.has(roleId)) {
      await member.roles.add(role);
      const winsChannel = client.channels.cache.get(process.env.WINS_CHANNEL_ID);
      if (winsChannel) {
        await winsChannel.send(`🎉 **${member.displayName}** just earned the **${roleName}** role! Another one locked in.`);
      }
    }
  };

  if (week >= 2 && (allResponses.includes('yes') || allResponses.includes('built'))) {
    await assign(process.env.BOT_BUILDER_ROLE_ID, 'Bot Builder');
  }
  if (week >= 3 && /1[0-9]|[2-9]\d/.test(allResponses)) {
    await assign(process.env.OUTREACH_ACTIVATED_ROLE_ID, 'Outreach Activated');
  }
  if (week >= 4 && (allResponses.includes('booked') || allResponses.includes('call booked'))) {
    await assign(process.env.CALL_BOOKER_ROLE_ID, 'Call Booker');
  }
  if (week >= 7 && (allResponses.includes('closed') || allResponses.includes('signed'))) {
    await assign(process.env.CLIENT_CLOSER_ROLE_ID, 'Client Closer');
    await assign(process.env.MRR_1K_ROLE_ID, '$1K Club');
  }
}

// ── Intro follow-up check (runs every hour) ───────────────────────────────────
cron.schedule('0 * * * *', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  const introChannel = guild.channels.cache.find(c => c.name === 'introductions');
  if (!introChannel) return;

  const messages = await introChannel.messages.fetch({ limit: 100 });
  messages.forEach(m => introPosters.add(m.author.id));

  for (const [userId, joinTime] of joinTimestamps.entries()) {
    if (Date.now() - joinTime > 24 * 60 * 60 * 1000 && !introPosters.has(userId)) {
      try {
        const member = await guild.members.fetch(userId);
        await member.send(`Hey! I noticed you haven't introduced yourself yet. Drop a quick intro in #introductions — just your name, what niche you're thinking about, and what you want to get out of LaunchPad. The group wants to meet you! 👋`);
        joinTimestamps.delete(userId); // only send once
      } catch { /* DMs may be closed */ }
    }
  }
});

// ── Monday check-in reminder (9 AM AEST = 11 PM Sunday UTC) ──────────────────
cron.schedule('0 23 * * 0', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;
  const week = getCurrentWeek();
  const channel = guild.channels.cache.get(process.env.CHECKIN_CHANNEL_ID);
  if (channel) {
    await channel.send(`👋 Hey team — it's check-in time! Type \`/checkin\` to submit your **Week ${week}** progress. Takes 2 minutes. Let's see where everyone's at. 🚀`);
  }
  weeklyCheckins.clear(); // reset for the new week
});

// ── Wednesday missed check-in DMs (12 PM AEST = 2 AM Wed UTC) ────────────────
cron.schedule('0 2 * * 3', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;
  const week = getCurrentWeek();

  const studentRole = guild.roles.cache.get(process.env.STUDENT_ROLE_ID);
  if (!studentRole) return;

  const members = await guild.members.fetch();
  const students = members.filter(m => m.roles.cache.has(process.env.STUDENT_ROLE_ID));

  for (const [id, member] of students) {
    if (!weeklyCheckins.has(id)) {
      try {
        await member.send(`Hey ${member.displayName}! I noticed you haven't checked in for Week ${week} yet. Everything okay? Type \`/checkin\` in <#${process.env.CHECKIN_CHANNEL_ID}> when you're ready. If you're stuck on something, drop it in #questions — don't sit on it. 💪`);
      } catch { /* DMs may be closed */ }
    }
  }
});

// ── Sunday leaderboard reminder post (8 PM AEST = 10 AM Sun UTC) ─────────────
cron.schedule('0 10 * * 0', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;
  const week = getCurrentWeek();
  const channel = guild.channels.cache.get(process.env.SCOREBOARD_CHANNEL_ID);
  if (channel) {
    await channel.send(`🏆 **WEEK ${week} LEADERBOARD** is coming tonight! Make sure your outreach is logged with \`/logoutreach\` before it posts. Every touch counts. 💪`);
  }
});

// ── Daily standup thread (8 AM AEST = 10 PM UTC previous day) ────────────────
cron.schedule('0 22 * * 0-4', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  const channel = guild.channels.cache.get(process.env.STANDUP_CHANNEL_ID);
  if (!channel) return;

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const dayName = days[(now.getDay() + 1) % 7];
  const dateStr = new Date(now.getTime() + 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  const thread = await channel.threads.create({
    name: `${dayName} ${dateStr} Standup`,
    autoArchiveDuration: 1440, // 24 hours
  });

  await thread.send(
    `Good morning team! Drop your standup below 👇\n\n` +
    `**1.** What did you do yesterday?\n` +
    `**2.** What are you working on today?\n` +
    `**3.** Anything blocking you?`
  );
});

// ── Weekly check-in questions per week ───────────────────────────────────────
function getWeekQuestions(week) {
  const map = {
    1: [
      { label: 'Have you chosen your agency name? What is it?', placeholder: 'e.g. Apex AI Agency' },
      { label: 'Is your website live? Drop the URL.', placeholder: 'e.g. https://apexai.com.au' },
      { label: 'Are your socials set up? (LinkedIn, Instagram, Facebook)', placeholder: 'e.g. Yes - all three created' },
      { label: 'Is your GHL account active with Twilio + calendar?', placeholder: 'e.g. Yes - tested and working' },
      { label: 'Modules watched so far? Anything blocking you?', placeholder: 'e.g. Watched 1-3, stuck on GHL setup' },
    ],
    2: [
      { label: 'Is your ClosedBot built and connected to GHL?', placeholder: 'e.g. Yes - tested and live' },
      { label: 'How many Q&As in your knowledge base? (target: 15-20)', placeholder: 'e.g. 18 Q&As added' },
      { label: 'Have you tested the full flow + had someone else test?', placeholder: 'e.g. Yes - my partner tested it' },
      { label: 'Have you recorded and posted your 60-sec demo video?', placeholder: 'e.g. Yes - posted on LinkedIn' },
      { label: 'How many prospects on your list? (target: 25)', placeholder: 'e.g. 28 prospects in GHL' },
    ],
    3: [
      { label: 'Is your prospect list at 50 names?', placeholder: 'e.g. Yes - 52 in GHL' },
      { label: 'Is your cold email sequence written and sending?', placeholder: 'e.g. Yes - 3-step sequence live' },
      { label: 'How many personalised DMs sent? (target: 10+)', placeholder: 'e.g. 14 DMs sent so far' },
      { label: 'Have you contacted your warm network?', placeholder: 'e.g. Yes - reached out to 8 contacts' },
      { label: 'Total outreach touches this week? Any blockers?', placeholder: 'e.g. 47 touches, stuck on email replies' },
    ],
    4: [
      { label: 'Are you hitting 20 outreach touches per day?', placeholder: 'e.g. Yes - averaging 22/day' },
      { label: 'How many discovery calls booked? (target: 2-3)', placeholder: 'e.g. 2 booked for next week' },
      { label: 'Have you written your top 5 objection responses?', placeholder: 'e.g. Yes - written and practiced' },
      { label: 'How many content pieces posted this week? (target: 3)', placeholder: 'e.g. 3 LinkedIn posts' },
      { label: 'What message is getting the best responses?', placeholder: 'e.g. The "missed call" angle is working' },
    ],
    5: [
      { label: 'How many discovery calls completed this week?', placeholder: 'e.g. 2 calls done' },
      { label: 'Are you using the PAINS/SPIN/BANT framework?', placeholder: 'e.g. Yes - used on both calls' },
      { label: 'Any hot prospects ready to close?', placeholder: 'e.g. Yes - 1 dentist wants a proposal' },
      { label: 'What is the main objection you keep hearing?', placeholder: 'e.g. "We already have a receptionist"' },
      { label: 'Following up within 24 hours of every call?', placeholder: 'e.g. Yes - sent follow-ups same day' },
    ],
    6: [
      { label: 'Have you built your proposal template?', placeholder: 'e.g. Yes - using the Launchpad template' },
      { label: 'What is your pricing model and price point?', placeholder: 'e.g. $800/mo setup + $500/mo retainer' },
      { label: 'How many proposals have you sent?', placeholder: 'e.g. 2 proposals sent' },
      { label: 'Any pricing objections? How did you handle them?', placeholder: 'e.g. Yes - broke it down to $125/week' },
      { label: 'Still hitting 20+ daily outreach touches?', placeholder: 'e.g. Yes - averaging 21/day' },
    ],
    7: [
      { label: 'Have you closed your first client? If yes, who + deal?', placeholder: 'e.g. Yes - dental clinic, $800/mo' },
      { label: 'If not closed, what is blocking the close?', placeholder: 'e.g. Waiting on their decision this week' },
      { label: 'Is your client onboarding process documented?', placeholder: 'e.g. Yes - using the Launchpad checklist' },
      { label: "Have you set up the client's GHL sub-account?", placeholder: 'e.g. Yes - sub-account ready' },
      { label: 'Pipeline status? (leads/calls/proposals/closed)', placeholder: 'e.g. 8 leads, 3 calls, 2 proposals, 1 closed' },
    ],
    8: [
      { label: "Is your first client's bot live and performing?", placeholder: 'e.g. Yes - live since Monday' },
      { label: 'What results is the bot generating?', placeholder: 'e.g. Captured 4 missed calls in first week' },
      { label: 'Are you collecting a testimonial or case study?', placeholder: 'e.g. Yes - client happy, collecting this week' },
      { label: 'Have you continued outreach for client #2?', placeholder: 'e.g. Yes - 18 touches/day' },
      { label: 'How many active conversations in your pipeline?', placeholder: 'e.g. 5 active conversations' },
    ],
    9: [
      { label: 'Have you created a case study from your first client?', placeholder: 'e.g. Yes - one-pager done' },
      { label: 'Are you using the case study in outreach?', placeholder: 'e.g. Yes - attaching to DMs' },
      { label: 'How many content pieces posted this week?', placeholder: 'e.g. 4 posts this week' },
      { label: 'Have you started video content? (Reels, LinkedIn)', placeholder: 'e.g. Posted first Reel on Tuesday' },
      { label: 'What is your total client count?', placeholder: 'e.g. 1 client, 2nd close this week' },
    ],
    10: [
      { label: 'Have you documented your sales process as an SOP?', placeholder: 'e.g. Yes - in Notion' },
      { label: 'Have you documented your client onboarding SOP?', placeholder: 'e.g. Yes - step by step checklist' },
      { label: 'Are you tracking your MRR? What is it?', placeholder: 'e.g. Yes - $1,500/mo MRR' },
      { label: 'What is your biggest time sink right now?', placeholder: 'e.g. Manual bot setup for each client' },
      { label: 'What would you delegate first if you could?', placeholder: 'e.g. The initial bot build' },
    ],
    11: [
      { label: 'How many active clients do you have?', placeholder: 'e.g. 3 clients' },
      { label: 'What is your current MRR?', placeholder: 'e.g. $2,400/mo' },
      { label: 'Tasks identified to delegate or automate?', placeholder: 'e.g. Onboarding calls, bot builds' },
      { label: 'Are you considering hiring? (VA, closer, tech)', placeholder: 'e.g. Yes - looking for a VA' },
      { label: 'What is your biggest bottleneck right now?', placeholder: 'e.g. Time - doing everything myself' },
    ],
    12: [
      { label: 'Total clients signed during LaunchPad?', placeholder: 'e.g. 3 clients total' },
      { label: 'What is your current MRR?', placeholder: 'e.g. $3,200/mo' },
      { label: 'What was your biggest win?', placeholder: 'e.g. Closing my first client in Week 7' },
      { label: 'What was your biggest lesson?', placeholder: 'e.g. Outreach volume is everything' },
      { label: 'What are your goals for the next 90 days?', placeholder: 'e.g. Hit $5K MRR, hire a VA' },
    ],
  };
  return map[week] || map[1];
}

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
