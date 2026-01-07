import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { Match, Team, MatchPlayer, Vote, User } from "./models/index.js";
import { ensureStatsAndLeaderboardMessages } from "./stats.js";

const QUEUE_CHANNEL_NAME = "v3-general";
const QUEUE_ADVANCED_CHANNEL_NAME = "v3-advanced";
const QUEUE_CHALLENGER_CHANNEL_NAME = "v3-challenger";
const QUEUE_ELITE_CHANNEL_NAME = "v3-elite";
const QUEUE_PRO_CHANNEL_NAME = "v3-pro";
const QUEUE_TAG = "[BOT-QUEUE-V1]";
const QUEUE_SIZE = 6;
const CATEGORY_GAMES = "Games";
const VOTE_TAG = "[BOT-VOTE-V1]";
const BAN_TAG = "[BOT-BAN-V1]";
const VOTE_THRESHOLD = 4;
const POINTS_WIN = Number(process.env.POINTS_WIN || 30);
const POINTS_LOSS = Number(process.env.POINTS_LOSS || 30);
const MAPS = ["Temple-M", "Old-School", "Neden-3", "Tunnel", "Colloseum", "Ziggurant", "Jungle"];
const BUTTON_COOLDOWN = 3000; // 3 seconds cooldown
const DODGE_BAN_DURATION = 60 * 60 * 1000; // 1 hour in ms
const DODGE_TIME_LIMIT = 5 * 60 * 1000; // 5 minutes in ms
const COOLDOWN_TTL = 60 * 60 * 1000; // Cleanup cooldowns after 1 hour
const MATCH_TTL = 12 * 60 * 60 * 1000; // Cleanup match states after 12 hours (fail-safe)

// Rate limiting for Discord API calls
class RateLimiter {
  constructor(maxRequests = 5, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async wait() {
    const now = Date.now();
    // Remove old requests outside the window
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.wait(); // Recurse after waiting
      }
    }
    
    this.requests.push(now);
  }
}

// Create rate limiters for different types of API calls
const syncPlayerRankLimiter = new RateLimiter(10, 1000); // 10 per second
const userUpdateLimiter = new RateLimiter(15, 1000); // 15 per second (less restrictive)
const messageLimiter = new RateLimiter(20, 1000); // 20 per second (message sends)

// Queue role restrictions
const QUEUE_ROLES = {
  [QUEUE_CHANNEL_NAME]: [], // v3-general has no role restriction
  [QUEUE_ADVANCED_CHANNEL_NAME]: ['advanced', 'challenger', 'elite', 'pro'], // v3-advanced requires these roles
  [QUEUE_CHALLENGER_CHANNEL_NAME]: ['challenger', 'elite', 'pro'], // v3-challenger requires these roles
  [QUEUE_ELITE_CHANNEL_NAME]: ['elite', 'pro'], // v3-elite requires these roles
  [QUEUE_PRO_CHANNEL_NAME]: ['pro'] // v3-pro requires pro role only
};

// Rank system based on points
const RANK_SYSTEM = {
  'Bronze': { min: 0, max: 1250 },
  'Silver': { min: 1251, max: 1500 },
  'Gold': { min: 1501, max: 1750 },
  'Platinium': { min: 1751, max: 2000 },
  'Diamond': { min: 2001, max: 2250 },
  'Supersonic': { min: 2251, max: Infinity }
};

const RANK_ROLES = ['Bronze', 'Silver', 'Gold', 'Platinium', 'Diamond', 'Supersonic'];

const MAP_IMAGES = {
  // TODO: replace with your hosted URLs
  "Temple-M": "https://i.postimg.cc/7Yppk9v2/temple_night_icon1.png",
  "Old-School": "https://i.postimg.cc/Kvdd2fXT/oldschool.png",
  "Neden-3": "https://i.postimg.cc/BQdd0pWD/neden_3.png",
  "Tunnel": "https://i.postimg.cc/x1MBTmYN/tn01.png",
  "Colloseum": "https://i.postimg.cc/SNwwhd0J/collo.png",
  "Ziggurant": "https://i.postimg.cc/8zMxPvDr/ziggurattd.png",
  "Jungle": "https://i.postimg.cc/tCLLjk0h/jungle.png"
};

const queues = new Map(); // guildId-channelName -> Set of user IDs
const matches = new Map();
const voteUpdateQueues = new Map(); // Queue vote updates per matchId to throttle API calls
const creatingGamesInGuild = new Map(); // guildId-channelName -> Promise (prevent simultaneous game creation with proper locking)
const buttonCooldowns = new Map(); // userId -> { timestamp, createdAt } for anti-spam + TTL
const dodgeBans = new Map(); // userId -> { timestamp, createdAt } when ban expires

// Cleanup interval: Remove expired cooldowns and old matches (every 30 minutes)
const CLEANUP_INTERVAL = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  
  // Clean up button cooldowns
  for (const [userId, data] of buttonCooldowns.entries()) {
    if (now - data.createdAt > COOLDOWN_TTL) {
      buttonCooldowns.delete(userId);
    }
  }
  
  // Clean up dodge bans
  for (const [userId, data] of dodgeBans.entries()) {
    if (now - data.createdAt > DODGE_BAN_DURATION + 1000) {
      dodgeBans.delete(userId);
    }
  }
  
  // Clean up old match states
  for (const [channelId, state] of matches.entries()) {
    if (now - state.createdAt > MATCH_TTL) {
      matches.delete(channelId);
      voteUpdateQueues.delete(state.matchId);
    }
  }
  
  console.log(`[Cleanup] Cleared expired data: cooldowns=${buttonCooldowns.size}, bans=${dodgeBans.size}, matches=${matches.size}`);
}, CLEANUP_INTERVAL);

function getQueue(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const key = `${guildId}-${channelName}`;
  if (!queues.has(key)) queues.set(key, new Set());
  return queues.get(key);
}

function getCreatingGamesSet(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const key = `${guildId}-${channelName}`;
  if (!creatingGamesInGuild.has(key)) creatingGamesInGuild.set(key, { locked: false, queue: [] });
  return creatingGamesInGuild.get(key);
}

// Acquires a lock for game creation to prevent race conditions
async function acquireGameCreationLock(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const lock = getCreatingGamesSet(guildId, channelName);
  while (lock.locked) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  lock.locked = true;
  return () => { lock.locked = false; }; // Returns unlock function
}

function getMapImageUrl(mapName) {
  return MAP_IMAGES[mapName] || null;
}

const EMOJI_MAP = {
  'collo': 'Colloseum',
  'zigguratt': 'Ziggurant',
  'trainstation': 'Tunnel',
  'tunnel': 'Tunnel',
  'templenighticon1': 'Temple-M',
  'oldschool': 'Old-School',
  'jungle': 'Jungle',
  'neden3': 'Neden-3'
};

function buildMapPoolString(guild) {
  return Object.entries(EMOJI_MAP).map(([emojiName, mapName]) => {
    const emoji = guild.emojis.cache.find(e => e.name === emojiName);
    const emojiStr = emoji ? emoji.toString() : `:${emojiName}:`;
    return `${emojiStr} ${mapName}`;
  }).join('\n');
}

function buildQueueEmbed(guild, count, channelName = QUEUE_CHANNEL_NAME) {
  const mapPool = buildMapPoolString(guild);
  let title = "General Queue V3";
  if (channelName === QUEUE_ADVANCED_CHANNEL_NAME) {
    title = "Advanced Queue V3";
  } else if (channelName === QUEUE_CHALLENGER_CHANNEL_NAME) {
    title = "Challenger Queue V3";
  } else if (channelName === QUEUE_ELITE_CHANNEL_NAME) {
    title = "Elite Queue V3";
  } else if (channelName === QUEUE_PRO_CHANNEL_NAME) {
    title = "Pro Queue V3";
  }
  
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription("V3, CPD, 30 minutes")
    .addFields(
      { name: "Instructions", value: "Use the buttons to join or leave the queue." },
      { name: "Map pool", value: mapPool },
      { name: "Players in queue", value: `${count}/${QUEUE_SIZE}` }
    )
    .setFooter({ text: guild.name });
}

function buildQueueRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("queue_join").setLabel("Join queue").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("queue_leave").setLabel("Leave queue").setStyle(ButtonStyle.Danger)
  );
}

export async function ensureQueueMessage(client, guild) {
  await ensureQueueMessageForChannel(client, guild, QUEUE_CHANNEL_NAME);
  await ensureQueueMessageForChannel(client, guild, QUEUE_ADVANCED_CHANNEL_NAME);
  await ensureQueueMessageForChannel(client, guild, QUEUE_CHALLENGER_CHANNEL_NAME);
  await ensureQueueMessageForChannel(client, guild, QUEUE_ELITE_CHANNEL_NAME);
  await ensureQueueMessageForChannel(client, guild, QUEUE_PRO_CHANNEL_NAME);
  await ensureCurrentQueueMessage(client, guild);
}

async function ensureQueueMessageForChannel(client, guild, channelName) {
  const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === channelName);
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m => m.author?.id === client.user.id && (m.content?.includes(QUEUE_TAG) || m.embeds?.length));

  const count = getQueue(guild.id, channelName).size;
  const embed = buildQueueEmbed(guild, count, channelName);
  const row = buildQueueRow();

  if (existing) {
    try {
      await existing.edit({ content: `${QUEUE_TAG} Use buttons to join/leave.`, embeds: [embed], components: [row] });
    } catch {}
  } else {
    await channel.send({ content: `${QUEUE_TAG} Use buttons to join/leave.`, embeds: [embed], components: [row] });
  }
}

async function updateQueueMessage(client, guild, channelName = QUEUE_CHANNEL_NAME) {
  return ensureQueueMessageForChannel(client, guild, channelName);
}

async function buildCurrentQueueEmbed(guild) {
  const allChannels = [QUEUE_CHANNEL_NAME, QUEUE_ADVANCED_CHANNEL_NAME, QUEUE_CHALLENGER_CHANNEL_NAME, QUEUE_ELITE_CHANNEL_NAME, QUEUE_PRO_CHANNEL_NAME];
  
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
      const players = await User.findAll({ where: { discordId: [...queue] } }).catch(() => []);
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

async function ensureCurrentQueueMessage(client, guild) {
  const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'current-q');
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m => m.author?.id === client.user.id && m.embeds?.some(e => e.title === '📊 Current Queues'));

  const embed = await buildCurrentQueueEmbed(guild);

  if (existing) {
    try {
      await existing.edit({ embeds: [embed] });
    } catch {}
  } else {
    await channel.send({ embeds: [embed] });
  }
}

async function updateCurrentQueueMessage(client, guild) {
  return ensureCurrentQueueMessage(client, guild);
}

async function persistMatchSetup(channel, state) {
  try {
    const match = await Match.create({ channelId: channel.id, status: "draft" });
    const teamA = await Team.create({ matchId: match.id, name: "Team A", captainDiscordId: state.captainA });
    const teamB = await Team.create({ matchId: match.id, name: "Team B", captainDiscordId: state.captainB });
    state.matchId = match.id;
    state.teamAId = teamA.id;
    state.teamBId = teamB.id;
    await MatchPlayer.create({ matchId: match.id, teamId: teamA.id, discordId: state.captainA, pickOrder: 0 });
    await MatchPlayer.create({ matchId: match.id, teamId: teamB.id, discordId: state.captainB, pickOrder: 0 });
    for (const uid of state.players) {
      if (uid === state.captainA || uid === state.captainB) continue;
      await MatchPlayer.create({ matchId: match.id, discordId: uid }).catch(() => {});
    }
  } catch (err) {
    console.error("Error persisting match setup:", err);
  }
}

function isUserInActiveMatch(userId) {
  for (const state of matches.values()) {
    if (!state.finalized && state.players && state.players.has(userId)) return true;
  }
  return false;
}

function isUserInOtherQueue(userId, currentChannelName, guildId) {
  // Check if user is in a different queue
  const allChannels = [QUEUE_CHANNEL_NAME, QUEUE_ADVANCED_CHANNEL_NAME, QUEUE_CHALLENGER_CHANNEL_NAME, QUEUE_ELITE_CHANNEL_NAME, QUEUE_PRO_CHANNEL_NAME];
  for (const channelName of allChannels) {
    if (channelName === currentChannelName) continue;
    const queue = getQueue(guildId, channelName);
    if (queue.has(userId)) return channelName;
  }
  return null;
}

function getRankByPoints(points) {
  for (const [rankName, range] of Object.entries(RANK_SYSTEM)) {
    if (points >= range.min && points <= range.max) {
      return rankName;
    }
  }
  return 'Bronze';
}

async function syncPlayerRank(guild, userId, newPoints) {
  await syncPlayerRankLimiter.wait(); // Rate limit
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const newRank = getRankByPoints(newPoints);
    
    // Remove all old rank roles
    for (const rankRole of RANK_ROLES) {
      const role = guild.roles.cache.find(r => r.name === rankRole);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles.remove(role).catch(() => {});
      }
    }

    // Add new rank role
    const newRankRole = guild.roles.cache.find(r => r.name === newRank);
    if (newRankRole && !member.roles.cache.has(newRankRole.id)) {
      await member.roles.add(newRankRole).catch(() => {});
    }
  } catch (err) {
    console.error('Error syncing player rank:', err);
  }
}

function isUserDodgeBanned(userId) {
  const banData = dodgeBans.get(userId);
  if (!banData) return false;
  if (Date.now() >= banData.timestamp) {
    dodgeBans.delete(userId);
    return false;
  }
  return true;
}

function getDodgeBanTimeLeft(userId) {
  const banData = dodgeBans.get(userId);
  if (!banData || Date.now() >= banData.timestamp) return 0;
  return Math.ceil((banData.timestamp - Date.now()) / 60000); // minutes left
}

async function getNextGameIndex() {
  try {
    const maxId = await Match.max("id");
    return (maxId || 0) + 1;
  } catch {
    return 1;
  }
}

async function createGameChannelForSix(client, guild, playerIds, queueChannelName = QUEUE_CHANNEL_NAME) {
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_GAMES);
  if (!category) {
    category = await guild.channels.create({ name: CATEGORY_GAMES, type: ChannelType.GuildCategory });
  }

  const nextIndex = String(await getNextGameIndex()).padStart(2, "0");
  let queueType = "general";
  if (queueChannelName === QUEUE_ADVANCED_CHANNEL_NAME) {
    queueType = "advanced";
  } else if (queueChannelName === QUEUE_CHALLENGER_CHANNEL_NAME) {
    queueType = "challenger";
  } else if (queueChannelName === QUEUE_ELITE_CHANNEL_NAME) {
    queueType = "elite";
  } else if (queueChannelName === QUEUE_PRO_CHANNEL_NAME) {
    queueType = "pro";
  }
  const name = `${nextIndex}-v3-${queueType}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];
  for (const uid of playerIds) {
    overwrites.push({ id: uid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const textChannel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites
  });

  // Select captains based on points: 1st captain = highest points, 2nd captain = 2nd highest points
  const users = await User.findAll({ where: { discordId: playerIds } });
  const sortedByPoints = users.sort((a, b) => b.points - a.points);
  const captainB = sortedByPoints[0].discordId; // 1st highest points
  const captainA = sortedByPoints[1].discordId; // 2nd highest points
  const others = playerIds.filter(id => id !== captainA && id !== captainB);

  const state = {
    guildId: guild.id,
    players: new Set(playerIds),
    captainA,
    captainB,
    teamA: new Set([captainA]),
    teamB: new Set([captainB]),
    remaining: new Set(others),
    phase: "A1",
    messageId: null,
    banMessageId: null,
    voteMessageId: null,
    matchId: null,
    teamAId: null,
    teamBId: null,
    availableMaps: [...MAPS],
    bannedMaps: [],
    selectedMap: null,
    finalized: false,
    voteStartTime: null, // Track when voting phase started for dodge time limit
    createdAt: Date.now() // For memory cleanup
  };

  const msg = await textChannel.send(await buildDraftPayload(textChannel, state));
  state.messageId = msg.id;
  matches.set(textChannel.id, state);
  await persistMatchSetup(textChannel, state);

  return state;
}

async function buildDraftPayload(channel, state) {
  const guild = channel.guild;
  const teamAList = [...state.teamA].map(id => `<@${id}>`).join(" ");
  const teamBList = [...state.teamB].map(id => `<@${id}>`).join(" ");

  let instruction = "";
  if (state.phase === "A1") instruction = `Captain A (<@${state.captainA}>) pick 1 player`;
  else if (state.phase === "B1") instruction = `Captain B (<@${state.captainB}>) pick 1st player`;
  else if (state.phase === "B2") instruction = `Captain B (<@${state.captainB}>) pick 2nd player`;
  else instruction = "Draft complete";

  const embed = new EmbedBuilder()
    .setTitle("Draft — General Queue V3")
    .addFields(
      { name: "Team A", value: teamAList || "—" },
      { name: "Team B", value: teamBList || "—" },
      { name: "Instruction", value: instruction }
    );

  // Build players list with points
  let playersList = "";
  for (const id of state.players) {
    try {
      const user = await User.findOne({ where: { discordId: id } });
      const points = user?.points || 1000;
      const member = await guild.members.fetch(id);
      const name = member.displayName || member.user.username;
      playersList += `${points} - ${name}\n`;
    } catch {
      playersList += `1000 - <@${id}>\n`;
    }
  }

  const components = await buildPickRows(guild, channel.id, state);
  return { content: `Players:\n${playersList}`, embeds: [embed], components };
}

async function buildPickRows(guild, channelId, state) {
  if (!(state.phase === "A1" || state.phase === "B1" || state.phase === "B2")) return [];
  const remaining = Array.from(state.remaining || []);
  if (remaining.length === 0) return [];

  const rows = [];
  let currentRow = new ActionRowBuilder();
  for (const uid of remaining) {
    let label = uid;
    try {
      const m = await guild.members.fetch(uid);
      label = m.displayName || m.user.username;
    } catch {}
    const btn = new ButtonBuilder().setCustomId(`pick:${channelId}:${uid}`).setLabel(label).setStyle(ButtonStyle.Secondary);
    currentRow.addComponents(btn);
    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);
  return rows;
}

async function updateDbOnPick(state, pickedId) {
  if (!state.matchId) return;
  try {
    const teamId = state.phase === "A1" ? state.teamAId : state.teamBId;
    const countA = state.teamA.size;
    const countB = state.teamB.size;
    const pickOrder = state.phase === "A1" ? countA : countB;
    await MatchPlayer.update({ teamId, pickOrder }, { where: { matchId: state.matchId, discordId: pickedId } }).catch(() => {});
  } catch (err) {
    console.error("Error updating DB on pick:", err);
  }
}

async function postBanMessage(channel, state) {
  const embed = new EmbedBuilder()
    .setTitle("Map Bans — General Queue V3")
    .setDescription("Each captain bans 1 map.")
    .addFields(
      { name: "Available Maps", value: state.availableMaps.join(", ") },
      { name: "Instruction", value: `Captain A (<@${state.captainA}>) bans first` }
    );

  const rows = [];
  let currentRow = new ActionRowBuilder();
  for (const map of state.availableMaps) {
    const btn = new ButtonBuilder().setCustomId(`ban:${channel.id}:${map}`).setLabel(map).setStyle(ButtonStyle.Secondary);
    currentRow.addComponents(btn);
    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  const msg = await channel.send({ content: `${BAN_TAG} Captains ban maps.`, embeds: [embed], components: rows });
  state.banMessageId = msg.id;
}

async function postSelectedMapMessage(channel, state) {
  const mapImageUrl = getMapImageUrl(state.selectedMap);
  if (!mapImageUrl) return;
  const embed = new EmbedBuilder()
    .setTitle(`Map choisie: ${state.selectedMap}`)
    .setImage(mapImageUrl);
  await channel.send({ embeds: [embed] });
}
function buildVoteEmbed(state, votersA, votersB) {
  const teamAList = [...state.teamA].map(id => `<@${id}>`).join(" ") || "—";
  const teamBList = [...state.teamB].map(id => `<@${id}>`).join(" ") || "—";
  const votersAText = votersA && votersA.length ? votersA.map(id => `<@${id}>`).join(" ") : "—";
  const votersBText = votersB && votersB.length ? votersB.map(id => `<@${id}>`).join(" ") : "—";
  return new EmbedBuilder()
    .setTitle("Vote for Winner")
    .setDescription(`Map: **${state.selectedMap}**`)
    .addFields(
      { name: "Team A", value: teamAList },
      { name: "Team B", value: teamBList },
      { name: "Threshold", value: `${VOTE_THRESHOLD} votes to finalize` },
      { name: `Votes Team A (${votersA.length}/${VOTE_THRESHOLD})`, value: votersAText },
      { name: `Votes Team B (${votersB.length}/${VOTE_THRESHOLD})`, value: votersBText }
    );
}

async function postVoteMessage(channel, state) {
  const embed = buildVoteEmbed(state, [], []);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote:${channel.id}:A`).setLabel("Vote Team A").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vote:${channel.id}:B`).setLabel("Vote Team B").setStyle(ButtonStyle.Primary)
  );
  const msg = await channel.send({ content: `${VOTE_TAG} Players, vote the winner.`, embeds: [embed], components: [row] });
  state.voteMessageId = msg.id;
}

async function updateVoteMessage(channel, state) {
  try {
    const votes = await Vote.findAll({ where: { matchId: state.matchId } });
    const votersA = votes.filter(v => v.voteForTeamId === state.teamAId).map(v => v.voterDiscordId);
    const votersB = votes.filter(v => v.voteForTeamId === state.teamBId).map(v => v.voterDiscordId);
    const embed = buildVoteEmbed(state, votersA, votersB);
    const msg = await channel.messages.fetch(state.voteMessageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [embed] });
  } catch (err) {
    console.error("updateVoteMessage error", err);
  }
}

async function queueVoteUpdate(channel, state) {
  // Throttle vote updates to 500ms intervals to reduce Discord API calls on bulk voting
  if (voteUpdateQueues.has(state.matchId)) return; // Already queued
  
  voteUpdateQueues.set(state.matchId, true);
  setTimeout(async () => {
    await updateVoteMessage(channel, state).catch(() => {});
    voteUpdateQueues.delete(state.matchId);
  }, 500);
}

async function tryFinalize(channel, state) {
  try {
    if (!state.matchId) return false;
    if (state.finalized) return true;

    const votes = await Vote.findAll({ where: { matchId: state.matchId } }).catch(() => []);
    const countA = votes.filter(v => v.voteForTeamId === state.teamAId).length;
    const countB = votes.filter(v => v.voteForTeamId === state.teamBId).length;
    const winnerKey = countA >= VOTE_THRESHOLD ? "A" : (countB >= VOTE_THRESHOLD ? "B" : null);
    if (!winnerKey) return false;

    const winners = winnerKey === "A" ? [...state.teamA] : [...state.teamB];
    const losers = winnerKey === "A" ? [...state.teamB] : [...state.teamA];

    const beforeStats = {};
    for (const uid of [...winners, ...losers]) {
      const user = await User.findOne({ where: { discordId: uid } }).catch(() => null);
      beforeStats[uid] = user ? { points: user.points || 1000 } : { points: 1000 };
    }

    const currentMatch = await Match.findByPk(state.matchId).catch(() => null);
    if (currentMatch?.status === "done") {
      state.finalized = true;
    } else {
      await Match.update({ status: "done" }, { where: { id: state.matchId } }).catch(() => {});

      for (const wid of winners) {
        await userUpdateLimiter.wait();
        await User.increment({ wins: 1 }, { where: { discordId: wid } }).catch(() => {});
        await userUpdateLimiter.wait();
        await User.increment({ points: POINTS_WIN }, { where: { discordId: wid } }).catch(() => {});
      }
      for (const lid of losers) {
        await userUpdateLimiter.wait();
        await User.increment({ losses: 1 }, { where: { discordId: lid } }).catch(() => {});
        await userUpdateLimiter.wait();
        await User.increment({ points: -POINTS_LOSS }, { where: { discordId: lid } }).catch(() => {});
      }

      // Sync ranks for all players
      const guild = channel.guild;
      for (const wid of winners) {
        const user = await User.findOne({ where: { discordId: wid } });
        if (user) await syncPlayerRank(guild, wid, user.points);
      }
      for (const lid of losers) {
        const user = await User.findOne({ where: { discordId: lid } });
        if (user) await syncPlayerRank(guild, lid, user.points);
      }

      state.finalized = true;
    }

    const gameId = channel.name.split("-")[0];
    const winnerTeamName = winnerKey === "A" ? "Alpha" : "Beta";
    const loserTeamName = winnerKey === "A" ? "Beta" : "Alpha";

    let resultsMsg = `**Game ${gameId} — Results**\n`;
    resultsMsg += `Map: ${state.selectedMap}\n`;
    resultsMsg += `Queue: General Queue V3\n\n`;
    resultsMsg += `**Winner Team: (${winnerTeamName})**\n`;
    for (const wid of winners) {
      const user = await User.findOne({ where: { discordId: wid } }).catch(() => null);
      const after = user?.points || (beforeStats[wid]?.points || 1000) + POINTS_WIN;
      const before = beforeStats[wid]?.points || 1000;
      const delta = after - before;
      const displayDelta = delta >= 0 ? `[+${delta}]` : `[${delta}]`;
      const displayName = user?.username || `${wid}`;
      resultsMsg += `<@${wid}> — ${displayName} ${before} ⟶ ${after} ${displayDelta}\n`;
    }
    resultsMsg += `\n**Loser Team: (${loserTeamName})**\n`;
    for (const lid of losers) {
      const user = await User.findOne({ where: { discordId: lid } }).catch(() => null);
      const after = user?.points || (beforeStats[lid]?.points || 1000) - POINTS_LOSS;
      const before = beforeStats[lid]?.points || 1000;
      const delta = after - before;
      const displayDelta = delta >= 0 ? `[+${delta}]` : `[${delta}]`;
      const displayName = user?.username || `${lid}`;
      resultsMsg += `<@${lid}> — ${displayName} ${before} ⟶ ${after} ${displayDelta}\n`;
    }


    try {
      const msg = await channel.messages.fetch(state.voteMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ components: [] }).catch(() => {});
      }
      try {
        const guild = channel.guild;
        let resultChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === "result");
        if (!resultChannel) {
          resultChannel = await guild.channels.create({ name: "result", type: ChannelType.GuildText });
        }
        await resultChannel.send({ content: resultsMsg }).catch(() => {});
      } catch (errPost) {
        console.error("Error posting results to result channel", errPost);
      }
    } catch (e) {
      console.error("Error posting results", e);
    }

    return true;
  } catch (err) {
    console.error("Error in tryFinalize:", err);
    return false;
  }
}

export function setupQueue(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isButton()) return;

      if (interaction.customId === "queue_join" || interaction.customId === "queue_leave") {
        const guild = interaction.guild;
        const guildId = guild.id;
        const memberId = interaction.user.id;
        const channel = interaction.channel;
        
        // Determine which queue based on channel name
        let channelName = QUEUE_CHANNEL_NAME;
        if (channel.name === QUEUE_ADVANCED_CHANNEL_NAME) {
          channelName = QUEUE_ADVANCED_CHANNEL_NAME;
        } else if (channel.name === QUEUE_CHALLENGER_CHANNEL_NAME) {
          channelName = QUEUE_CHALLENGER_CHANNEL_NAME;
        } else if (channel.name === QUEUE_ELITE_CHANNEL_NAME) {
          channelName = QUEUE_ELITE_CHANNEL_NAME;
        } else if (channel.name === QUEUE_PRO_CHANNEL_NAME) {
          channelName = QUEUE_PRO_CHANNEL_NAME;
        }
        
        // Anti-spam cooldown check
        const lastClick = buttonCooldowns.get(memberId);
        const now = Date.now();
        if (lastClick && (now - lastClick.timestamp) < BUTTON_COOLDOWN) {
          const timeLeft = Math.ceil((BUTTON_COOLDOWN - (now - lastClick.timestamp)) / 1000);
          await interaction.reply({ content: `Please wait ${timeLeft}s before clicking again.`, flags: MessageFlags.Ephemeral });
          return;
        }
        buttonCooldowns.set(memberId, { timestamp: now, createdAt: now });
        
        const q = getQueue(guildId, channelName);

        if (interaction.customId === "queue_join") {
          // Check if already in another queue
          const otherQueue = isUserInOtherQueue(memberId, channelName, guildId);
          if (otherQueue) {
            await interaction.reply({ content: `You are already in the ${otherQueue} queue. Please leave it first.`, flags: MessageFlags.Ephemeral });
            return;
          }
          
          // Check role restrictions for any queue that requires roles
          const requiredRoles = QUEUE_ROLES[channelName];
          if (requiredRoles && requiredRoles.length > 0) {
            const hasRole = interaction.member.roles.cache.some(r => requiredRoles.includes(r.name.toLowerCase()));
            if (!hasRole) {
              await interaction.reply({ content: `You need one of these roles to join: ${requiredRoles.join(', ')}.`, flags: MessageFlags.Ephemeral });
              return;
            }
          }
          
          if (isUserDodgeBanned(memberId)) {
            const timeLeft = getDodgeBanTimeLeft(memberId);
            await interaction.reply({ content: `You are banned from queue for ${timeLeft} more minutes (dodged a match).`, flags: MessageFlags.Ephemeral });
            return;
          }
          if (isUserInActiveMatch(memberId)) {
            await interaction.reply({ content: "You already in game.", flags: MessageFlags.Ephemeral });
            return;
          }
          q.add(memberId);
          await interaction.reply({ content: "You joined the queue.", flags: MessageFlags.Ephemeral });
        } else {
          q.delete(memberId);
          await interaction.reply({ content: "You left the queue.", flags: MessageFlags.Ephemeral });
        }

        await updateQueueMessage(client, guild, channelName);
        await updateCurrentQueueMessage(client, guild);

        // Acquire lock to prevent race conditions when creating game
        if (q.size >= QUEUE_SIZE) {
          const unlock = await acquireGameCreationLock(guildId, channelName);
          try {
            // Re-check queue size after acquiring lock (another request might have taken players)
            if (q.size >= QUEUE_SIZE) {
              const players = [...q].slice(0, QUEUE_SIZE);
              for (const id of players) q.delete(id);
              await updateQueueMessage(client, guild, channelName);
              await updateCurrentQueueMessage(client, guild);
              await createGameChannelForSix(client, guild, players, channelName);
            }
          } finally {
            unlock();
          }
        }
        return;
      }

      if (interaction.customId.startsWith("pick:")) {
        const [, channelId, pickedId] = interaction.customId.split(":");
        if (interaction.channelId !== channelId) return;
        const state = matches.get(channelId);
        if (!state) {
          await interaction.reply({ content: "Draft not active here.", flags: MessageFlags.Ephemeral });
          return;
        }

        const pickerId = interaction.user.id;
        if (state.phase === "A1" && pickerId !== state.captainA) {
          await interaction.reply({ content: "Not your turn (Captain A picks first).", flags: MessageFlags.Ephemeral });
          return;
        }
        if ((state.phase === "B1" || state.phase === "B2") && pickerId !== state.captainB) {
          await interaction.reply({ content: "Not your turn (Captain B picking).", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!state.remaining.has(pickedId)) {
          await interaction.reply({ content: "Player already picked or invalid.", flags: MessageFlags.Ephemeral });
          return;
        }

        state.remaining.delete(pickedId);
        if (state.phase === "A1") {
          state.teamA.add(pickedId);
          await updateDbOnPick(state, pickedId);
          state.phase = "B1";
        } else if (state.phase === "B1") {
          state.teamB.add(pickedId);
          await updateDbOnPick(state, pickedId);
          state.phase = "B2";
        } else if (state.phase === "B2") {
          state.teamB.add(pickedId);
          await updateDbOnPick(state, pickedId);
          const last = [...state.remaining][0];
          if (last) {
            state.teamA.add(last);
            await MatchPlayer.update({ teamId: state.teamAId, pickOrder: state.teamA.size }, { where: { matchId: state.matchId, discordId: last } });
          }
          state.remaining.clear();
          state.phase = "BAN_A";
        }

        try {
          const channel = interaction.channel;
          const msg = await channel.messages.fetch(state.messageId).catch(() => null);
          const payload = await buildDraftPayload(channel, state);
          if (msg) await msg.edit(payload); else await channel.send(payload);
          if (state.phase === "BAN_A") {
            await postBanMessage(channel, state);
          }
        } catch (e) { console.error("update draft message error", e); }

        await interaction.reply({ content: "Pick enregistré.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId.startsWith("ban:")) {
        const [, channelId, mapName] = interaction.customId.split(":");
        if (interaction.channelId !== channelId) return;
        const state = matches.get(channelId);
        if (!state || state.phase !== "BAN_A" && state.phase !== "BAN_B") {
          await interaction.reply({ content: "Bans not active now.", flags: MessageFlags.Ephemeral });
          return;
        }
        const bannerId = interaction.user.id;
        if (state.phase === "BAN_A" && bannerId !== state.captainA) {
          await interaction.reply({ content: "Not your turn (Captain A bans first).", flags: MessageFlags.Ephemeral });
          return;
        }
        if (state.phase === "BAN_B" && bannerId !== state.captainB) {
          await interaction.reply({ content: "Not your turn (Captain B bans now).", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!state.availableMaps.includes(mapName)) {
          await interaction.reply({ content: "Map already banned or invalid.", flags: MessageFlags.Ephemeral });
          return;
        }
        state.availableMaps = state.availableMaps.filter(m => m !== mapName);
        state.bannedMaps.push(mapName);
        if (state.phase === "BAN_A") {
          state.phase = "BAN_B";
        } else {
          state.selectedMap = state.availableMaps[Math.floor(Math.random() * state.availableMaps.length)];
          state.phase = "VOTE";
          state.voteStartTime = Date.now(); // Track when voting started for dodge timer
        }
        try {
          const channel = interaction.channel;
          const msg = await channel.messages.fetch(state.banMessageId).catch(() => null);
          if (state.phase === "VOTE") {
            if (msg) await msg.delete().catch(() => {});
            await postSelectedMapMessage(channel, state);
            await postVoteMessage(channel, state);
          } else {
            const embed = new EmbedBuilder()
              .setTitle("Map Bans — General Queue V3")
              .setDescription("Each captain bans 1 map.")
              .addFields(
                { name: "Available Maps", value: state.availableMaps.join(", ") },
                { name: "Banned Maps", value: state.bannedMaps.join(", ") },
                { name: "Instruction", value: `Captain B (<@${state.captainB}>) bans now` }
              );
            const rows = [];
            let currentRow = new ActionRowBuilder();
            for (const map of state.availableMaps) {
              const btn = new ButtonBuilder().setCustomId(`ban:${channel.id}:${map}`).setLabel(map).setStyle(ButtonStyle.Secondary);
              currentRow.addComponents(btn);
              if (currentRow.components.length === 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
              }
            }
            if (currentRow.components.length > 0) rows.push(currentRow);
            if (msg) await msg.edit({ embeds: [embed], components: rows });
          }
        } catch (e) { console.error("update ban message error", e); }
        await interaction.reply({ content: "Ban enregistré.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.customId.startsWith("vote:")) {
        const [, channelId, teamKey] = interaction.customId.split(":");
        if (interaction.channelId !== channelId) return;
        const state = matches.get(channelId);
        if (!state || !state.matchId) {
          await interaction.reply({ content: "Voting not available.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voterId = interaction.user.id;
        if (!state.players.has(voterId)) {
          await interaction.reply({ content: "Only match players can vote.", flags: MessageFlags.Ephemeral });
          return;
        }
        const voteForTeamId = teamKey === "A" ? state.teamAId : state.teamBId;
        const existing = await Vote.findOne({ where: { matchId: state.matchId, voterDiscordId: voterId } });
        if (existing) {
          await existing.update({ voteForTeamId }).catch(() => {});
          await interaction.reply({ content: "Vote updated.", flags: MessageFlags.Ephemeral });
        } else {
          await Vote.create({ matchId: state.matchId, voterDiscordId: voterId, voteForTeamId });
          await interaction.reply({ content: "Vote counted.", flags: MessageFlags.Ephemeral });
        }
        const finalized = await tryFinalize(interaction.channel, state);
        if (finalized) {
          matches.delete(interaction.channelId);
          voteUpdateQueues.delete(state.matchId); // Clean up throttle queue
          await ensureStatsAndLeaderboardMessages(interaction.client, interaction.guild);
          setTimeout(() => {
            try { interaction.channel.delete().catch(() => {}); } catch {}
          }, 5000);
        } else {
          await queueVoteUpdate(interaction.channel, state); // Throttle vote updates
        }
        return;
      }

      // Handle /dodge command
      if (interaction.isChatInputCommand() && interaction.commandName === 'dodge') {
        const channelId = interaction.channelId;
        const state = matches.get(channelId);
        const userId = interaction.user.id;

        if (!state) {
          await interaction.reply({ content: 'This command can only be used in an active match channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!state.players.has(userId)) {
          await interaction.reply({ content: 'Only players in this match can dodge.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (!state.voteStartTime) {
          await interaction.reply({ content: 'You can only dodge after the map bans are complete.', flags: MessageFlags.Ephemeral });
          return;
        }

        const elapsedTime = Date.now() - state.voteStartTime;
        if (elapsedTime > DODGE_TIME_LIMIT) {
          await interaction.reply({ content: 'Dodge window expired (5 minutes after map bans).', flags: MessageFlags.Ephemeral });
          return;
        }

        // Ban the dodger for 1 hour
        const banExpiry = Date.now() + DODGE_BAN_DURATION;
        dodgeBans.set(userId, { timestamp: banExpiry, createdAt: Date.now() });

        // Notify all players in the match
        const playerMentions = [...state.players].map(id => `<@${id}>`).join(' ');
        await interaction.channel.send(`**Match cancelled**: <@${userId}> dodged the match and is banned from queue for 1 hour.\n${playerMentions}`);

        // Mark match as cancelled in DB
        if (state.matchId) {
          await Match.update({ status: 'cancelled' }, { where: { id: state.matchId } }).catch(() => {});
        }

        // Clean up
        matches.delete(channelId);
        voteUpdateQueues.delete(state.matchId);

        await interaction.reply({ content: 'You dodged the match. You are banned from queue for 1 hour.', flags: MessageFlags.Ephemeral });

        // Delete channel after 5 seconds
        setTimeout(() => {
          try { interaction.channel.delete().catch(() => {}); } catch {}
        }, 5000);

        return;
      }
    } catch (err) {
      console.error("Queue interaction error", err);
      if (!interaction.replied) {
        try { await interaction.reply({ content: "Error handling queue action.", flags: MessageFlags.Ephemeral }); } catch {}
      }
    }
  });

  // Handle /ban-player command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'ban-player') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can ban players.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');
      const durationStr = interaction.options.getString('duration');

      // Parse duration (2h, 3h, 1j, 30m, etc.)
      const match = durationStr.match(/^(\d+)(m|h|j|d)$/i);
      if (!match) {
        await interaction.reply({ content: 'Invalid duration format. Use: 30m, 2h, 1j (m=minutes, h=hours, j/d=days)', flags: MessageFlags.Ephemeral });
        return;
      }

      const value = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      let durationMs = 0;

      if (unit === 'm') durationMs = value * 60 * 1000;
      else if (unit === 'h') durationMs = value * 60 * 60 * 1000;
      else if (unit === 'j' || unit === 'd') durationMs = value * 24 * 60 * 60 * 1000;

      const banExpiry = Date.now() + durationMs;
      dodgeBans.set(targetUser.id, { timestamp: banExpiry, createdAt: Date.now() });

      // Post to #bann channel
      try {
        const guild = interaction.guild;
        let bannChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'bann');
        if (!bannChannel) {
          bannChannel = await guild.channels.create({ name: 'bann', type: ChannelType.GuildText });
        }
        await bannChannel.send(`<@${targetUser.id}> vous êtes banni ${durationStr}.`);
      } catch (errBann) {
        console.error('Error posting to bann channel:', errBann);
      }

      await interaction.reply({ content: `<@${targetUser.id}> banned from queue for ${durationStr}.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Ban player error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error banning player.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle /reset-match command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'reset-match') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can reset matches.', flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel('channel');
      const state = matches.get(channel.id);

      if (!state) {
        await interaction.reply({ content: 'No active match found in that channel.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Mark match as cancelled in DB
      if (state.matchId) {
        await Match.update({ status: 'cancelled' }, { where: { id: state.matchId } }).catch(() => {});
      }

      // Clean up
      matches.delete(channel.id);
      voteUpdateQueues.delete(state.matchId);

      await interaction.reply({ content: `Match in ${channel} has been reset. Channel will be deleted in 5 seconds.`, flags: MessageFlags.Ephemeral });

      // Delete channel
      setTimeout(() => {
        try { channel.delete().catch(() => {}); } catch {}
      }, 5000);

    } catch (err) {
      console.error('Reset match error:', err);
      await interaction.reply({ content: 'Error resetting match.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // Handle /unban-player command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'unban-player') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can unban players.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');

      // Check if player is actually banned
      if (!dodgeBans.has(targetUser.id)) {
        await interaction.reply({ content: `<@${targetUser.id}> is not banned from queue.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Remove the ban
      dodgeBans.delete(targetUser.id);

      // Post to #bann channel
      try {
        const guild = interaction.guild;
        let bannChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'bann');
        if (bannChannel) {
          await bannChannel.send(`<@${targetUser.id}> a été débanni.`);
        }
      } catch (errBann) {
        console.error('Error posting to bann channel:', errBann);
      }

      await interaction.reply({ content: `<@${targetUser.id}> unbanned from queue.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Unban player error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error unbanning player.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle /edit-player-stats command (admin only)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'edit-player-stats') return;

    try {
      const isAdmin = interaction.member.roles.cache.some(r => r.name === 'admin') || interaction.user.id === interaction.guild.ownerId;
      if (!isAdmin) {
        await interaction.reply({ content: 'Only admins can edit player stats.', flags: MessageFlags.Ephemeral });
        return;
      }

      const targetUser = interaction.options.getUser('player');

      // Get current stats
      const user = await User.findOne({ where: { discordId: targetUser.id } });
      if (!user) {
        await interaction.reply({ content: `<@${targetUser.id}> is not registered in the system.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Create Modal with pre-filled stats
      const modal = new ModalBuilder()
        .setCustomId(`edit-stats-${targetUser.id}`)
        .setTitle(`Edit ${user.username} Stats`);

      const pointsInput = new TextInputBuilder()
        .setCustomId('points-input')
        .setLabel('Points')
        .setStyle(TextInputStyle.Short)
        .setValue(user.points.toString())
        .setRequired(true);

      const winsInput = new TextInputBuilder()
        .setCustomId('wins-input')
        .setLabel('Wins')
        .setStyle(TextInputStyle.Short)
        .setValue(user.wins.toString())
        .setRequired(true);

      const lossesInput = new TextInputBuilder()
        .setCustomId('losses-input')
        .setLabel('Losses')
        .setStyle(TextInputStyle.Short)
        .setValue(user.losses.toString())
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(pointsInput),
        new ActionRowBuilder().addComponents(winsInput),
        new ActionRowBuilder().addComponents(lossesInput)
      );

      await interaction.showModal(modal);
    } catch (err) {
      console.error('Edit player stats error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error opening stats editor.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Handle Modal submission for edit-player-stats
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('edit-stats-')) return;

    try {
      const targetUserId = interaction.customId.replace('edit-stats-', '');
      
      // Validate Discord ID format
      if (!/^\d{17,19}$/.test(targetUserId)) {
        await interaction.reply({ content: 'Invalid user ID.', flags: MessageFlags.Ephemeral });
        return;
      }

      const points = parseInt(interaction.fields.getTextInputValue('points-input'));
      const wins = parseInt(interaction.fields.getTextInputValue('wins-input'));
      const losses = parseInt(interaction.fields.getTextInputValue('losses-input'));

      // Validate numbers
      if (isNaN(points) || isNaN(wins) || isNaN(losses)) {
        await interaction.reply({ content: 'All values must be valid numbers.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Validate non-negative values
      if (points < 0 || wins < 0 || losses < 0) {
        await interaction.reply({ content: 'Points, wins, and losses must be >= 0.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Get user and old values
      const user = await User.findOne({ where: { discordId: targetUserId } });
      if (!user) {
        await interaction.reply({ content: 'Player not found.', flags: MessageFlags.Ephemeral });
        return;
      }

      const oldPoints = user.points;
      const oldWins = user.wins;
      const oldLosses = user.losses;

      // Update stats
      await user.update({ points, wins, losses });

      // Sync rank after points update
      await syncPlayerRank(interaction.guild, targetUserId, points);

      const confirmMessage = `**${user.username}** stats updated:\n` +
        `Points: **${oldPoints}** → **${points}**\n` +
        `Wins: **${oldWins}** → **${wins}**\n` +
        `Losses: **${oldLosses}** → **${losses}**`;

      await interaction.reply({ content: confirmMessage, flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Edit player stats modal error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error updating player stats.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });
}

export function getDodgeCommand() {
  return new SlashCommandBuilder()
    .setName('dodge')
    .setDescription('Leave the match within 5 minutes after map bans (1 hour queue ban)');
}

export function getResetMatchCommand() {
  return new SlashCommandBuilder()
    .setName('reset-match')
    .setDescription('Cancel an active match (admin only)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Match channel to reset')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    );
}

export function getBanPlayerCommand() {
  return new SlashCommandBuilder()
    .setName('ban-player')
    .setDescription('Ban a player from queue for a duration (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to ban')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('Ban duration (e.g. 30m, 2h, 1j)')
        .setRequired(true)
    );
}

export function getUnbanPlayerCommand() {
  return new SlashCommandBuilder()
    .setName('unban-player')
    .setDescription('Unban a player from queue (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to unban')
        .setRequired(true)
    );
}

export function getEditPlayerStatsCommand() {
  return new SlashCommandBuilder()
    .setName('edit-player-stats')
    .setDescription('Edit player stats (admin only)')
    .addUserOption(option =>
      option.setName('player')
        .setDescription('Player to edit')
        .setRequired(true)
    );
}

export { getRankByPoints, syncPlayerRank };
