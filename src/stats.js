import { SlashCommandBuilder, EmbedBuilder, Events } from 'discord.js';
import { User } from './models/index.js';

export async function setupStats(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'leaderboard') return;

    try {
      await interaction.deferReply();

      const users = await User.findAll({
        order: [['points', 'DESC']],
        limit: 10
      });

      if (!users || users.length === 0) {
        await interaction.editReply({ content: 'No players registered yet.' });
        return;
      }

      let leaderboardText = '**🏆 Top 10 Players**\n\n';
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        leaderboardText += `${medal} **${i + 1}.** <@${user.discordId}> — ${user.points} pts (${user.wins}W/${user.losses}L)\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle('Ranked Leaderboard')
        .setDescription(leaderboardText)
        .setFooter({ text: 'Updated ' + new Date().toLocaleString() });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Leaderboard command error', err);
      await interaction.editReply({ content: 'Error fetching leaderboard.' }).catch(() => {});
    }
  });
}

export function getLeaderboardCommand() {
  return new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show top 10 players by points');
}
