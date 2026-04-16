require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('checkin')
    .setDescription('Submit your weekly LaunchPad check-in'),
  new SlashCommandBuilder()
    .setName('win')
    .setDescription('Log a win to celebrate with the group'),
  new SlashCommandBuilder()
    .setName('logoutreach')
    .setDescription('Log your daily outreach numbers'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
})();