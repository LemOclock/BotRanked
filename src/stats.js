import { SlashCommandBuilder, EmbedBuilder, Events, ChannelType } from 'discord.js';
import { User } from './models/index.js';

export async function setupStats(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`Command received: ${interaction.commandName}`); // Debug log

    if (interaction.commandName === 'leaderboard') {
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
    } else if (interaction.commandName === 'stats') {
      // Only allow /stats in the 'stats' channel
      if (interaction.channel?.name !== 'stats') {
        await interaction.reply({ content: 'You can only use /stats in # stats', flags: 64 });
        return;
      }

      try {
        await interaction.deferReply();

        const targetUser = interaction.options.getUser('user');
        const user = await User.findOne({ where: { discordId: targetUser.id } });

        if (!user) {
          await interaction.editReply({ content: `<@${targetUser.id}> not registered yet.` });
          return;
        }

        const totalGames = user.wins + user.losses;
        const winRate = totalGames > 0 ? Math.round((user.wins / totalGames) * 100) : 0;

        const embed = new EmbedBuilder()
          .setTitle(`📊 Stats for ${user.username || targetUser.username}`)
          .addFields(
            { name: 'Points', value: `${user.points}`, inline: true },
            { name: 'Wins', value: `${user.wins}`, inline: true },
            { name: 'Losses', value: `${user.losses}`, inline: true },
            { name: 'Win Rate', value: `${winRate}%`, inline: true },
            { name: 'Total Games', value: `${totalGames}`, inline: true }
          )
          .setFooter({ text: 'Last updated ' + new Date().toLocaleString() });

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('Stats command error', err);
        await interaction.editReply({ content: 'Error fetching stats.' }).catch(() => {});
      }
    }
  });
}

async function buildLeaderboardEmbed() {
  const users = await User.findAll({
    order: [['points', 'DESC']],
    limit: 10
  });

  if (!users || users.length === 0) {
    return new EmbedBuilder().setTitle('Ranked Leaderboard').setDescription('No players registered yet.');
  }

  let leaderboardText = '**🏆 Top 10 Players**\n\n';
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    leaderboardText += `${medal} **${i + 1}.** <@${user.discordId}> — ${user.points} pts (${user.wins}W/${user.losses}L)\n`;
  }

  return new EmbedBuilder()
    .setTitle('Ranked Leaderboard')
    .setDescription(leaderboardText)
    .setFooter({ text: 'Updated ' + new Date().toLocaleString() });
}

export async function ensureStatsAndLeaderboardMessages(client, guild) {
  try {
    const leaderboardChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'leaderboard');
    if (!leaderboardChannel) return;

    const messages = await leaderboardChannel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = messages?.find(m => m.author?.id === client.user.id && m.embeds?.length);

    const leaderboardEmbed = await buildLeaderboardEmbed();

    if (existing) {
      try {
        await existing.edit({ embeds: [leaderboardEmbed] });
      } catch {}
    } else {
      await leaderboardChannel.send({ embeds: [leaderboardEmbed] });
    }
  } catch (err) {
    console.error('Error updating leaderboard message:', err);
  }
}

export function getLeaderboardCommand() {
  return new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show top 10 players by points');
}

export function getStatsCommand() {
  return new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show player stats')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Player to check stats for')
        .setRequired(true)
    );
}
