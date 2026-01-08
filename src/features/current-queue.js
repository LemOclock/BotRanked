import { EmbedBuilder, ChannelType } from "discord.js";
import { User } from "../models/index.js";
import { getCachedUsers } from "../utils/user-cache.js";

const QUEUE_CHANNEL_NAME = "v3-general";
const QUEUE_ADVANCED_CHANNEL_NAME = "v3-advanced";
const QUEUE_CHALLENGER_CHANNEL_NAME = "v3-challenger";
const QUEUE_ELITE_CHANNEL_NAME = "v3-elite";
const QUEUE_PRO_CHANNEL_NAME = "v3-pro";
const QUEUE_SIZE = 6;

/**
 * Get rank name based on points
 */
function getRankByPoints(points) {
  const RANK_SYSTEM = {
    'Bronze': { min: 0, max: 1250 },
    'Silver': { min: 1251, max: 1500 },
    'Gold': { min: 1501, max: 1750 },
    'Platinium': { min: 1751, max: 2000 },
    'Diamond': { min: 2001, max: 2250 },
    'Supersonic': { min: 2251, max: Infinity }
  };
  
  for (const [rankName, range] of Object.entries(RANK_SYSTEM)) {
    if (points >= range.min && points <= range.max) {
      return rankName;
    }
  }
  return 'Bronze';
}

/**
 * Build embed showing all queues status
 */
async function buildCurrentQueueEmbed(guild, getQueue) {
  const allChannels = [
    QUEUE_CHANNEL_NAME, 
    QUEUE_ADVANCED_CHANNEL_NAME, 
    QUEUE_CHALLENGER_CHANNEL_NAME, 
    QUEUE_ELITE_CHANNEL_NAME, 
    QUEUE_PRO_CHANNEL_NAME
  ];
  
  let description = '';
  
  for (const channelName of allChannels) {
    const queue = getQueue(guild.id, channelName);
    let displayName = 'General';
    if (channelName === QUEUE_ADVANCED_CHANNEL_NAME) displayName = 'Advanced';
    else if (channelName === QUEUE_CHALLENGER_CHANNEL_NAME) displayName = 'Challenger';
    else if (channelName === QUEUE_ELITE_CHANNEL_NAME) displayName = 'Elite';
    else if (channelName === QUEUE_PRO_CHANNEL_NAME) displayName = 'Pro';
    
    description += `\n**${displayName}** [${queue.size}/${QUEUE_SIZE}]\n`;
    
    if (queue.size === 0) {
      description += '  *Empty*\n';
    } else {
      const players = await getCachedUsers([...queue]);
      const playersWithPoints = [...queue].map(uid => {
        const user = players.find(u => u.discordId === uid);
        const points = user?.points || 1000;
        const rank = getRankByPoints(points);
        const pseudo = user?.username || uid;
        return { uid, pseudo, points, rank };
      }).sort((a, b) => b.points - a.points);
      
      for (const { uid, pseudo, points, rank } of playersWithPoints) {
        description += `  • <@${uid}> - **${pseudo}** (${points} pts) [${rank}]\n`;
      }
    }
  }
  
  return new EmbedBuilder()
    .setTitle('📊 Current Queues')
    .setDescription(description)
    .setColor('#00ff00')
    .setFooter({ text: guild.name, iconURL: guild.iconURL() });
}

/**
 * Ensure current-q message exists and is up to date
 */
export async function ensureCurrentQueueMessage(client, guild, getQueue) {
  const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'current-q');
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m => m.author?.id === client.user.id && m.embeds?.some(e => e.title === '📊 Current Queues'));

  const embed = await buildCurrentQueueEmbed(guild, getQueue);

  if (existing) {
    try {
      await existing.edit({ embeds: [embed] });
    } catch {}
  } else {
    await channel.send({ embeds: [embed] });
  }
}

/**
 * Update current-q message
 */
export async function updateCurrentQueueMessage(client, guild, getQueue) {
  return ensureCurrentQueueMessage(client, guild, getQueue);
}

// Debouncing system to batch updates
const updateQueue = new Set(); // Guild IDs pending update
let updateInterval = null;
let clientRef = null;
let getQueueRef = null;

/**
 * Schedule a debounced update for current-q (batches updates every 2 seconds)
 * @param {Client} client - Discord client
 * @param {Guild} guild - Discord guild
 * @param {Function} getQueue - Function to get queue
 */
export function scheduleCurrentQueueUpdate(client, guild, getQueue) {
  // Store references for the interval
  if (!clientRef) clientRef = client;
  if (!getQueueRef) getQueueRef = getQueue;
  
  // Add guild to update queue
  updateQueue.add(guild.id);
  
  // Start interval if not already running
  if (!updateInterval) {
    updateInterval = setInterval(async () => {
      if (updateQueue.size === 0) return;
      
      for (const guildId of updateQueue) {
        const guild = clientRef.guilds.cache.get(guildId);
        if (guild) {
          await ensureCurrentQueueMessage(clientRef, guild, getQueueRef).catch(err => {
            console.error(`Error updating current-q for guild ${guildId}:`, err);
          });
        }
      }
      
      updateQueue.clear();
    }, 2000); // Batch updates every 2 seconds
  }
}
