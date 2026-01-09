import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ChannelType, PermissionFlagsBits, MessageFlags, SlashCommandBuilder } from "discord.js";
import { Match, Team, MatchPlayer, Vote, User } from "./models/index.js";
import { ensureStatsAndLeaderboardMessages } from "./stats.js";
import { syncPlayerRankLimiter, userUpdateLimiter } from "./utils/rate-limiter.js";
import { startMemoryCleanup } from "./utils/memory-cleanup.js";
import { getCachedUser, invalidateUserCache } from "./utils/user-cache.js";
import { ensureCurrentQueueMessage, scheduleCurrentQueueUpdate } from "./features/current-queue.js";
import { setupAdminCommands, getResetMatchCommand, getBanPlayerCommand, getUnbanPlayerCommand, getEditPlayerStatsCommand, getDodgeCommand, getForceDodgeCommand } from "./features/admin-commands.js";

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
const COOLDOWN_TTL = 60 * 60 * 1000; // Cleanup cooldowns after 1 hour
const MATCH_TTL = 12 * 60 * 60 * 1000; // Cleanup match states after 12 hours (fail-safe)

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
const queueLocks = new Map(); // guildId-channelName -> { locked: bool, waiters: [] } to prevent race conditions
const matches = new Map();
const voteUpdateQueues = new Map(); // Queue vote updates per matchId to throttle API calls
const creatingGamesInGuild = new Map(); // guildId-channelName -> Promise (prevent simultaneous game creation with proper locking)
const buttonCooldowns = new Map(); // userId -> { timestamp, createdAt } for anti-spam + TTL
const dodgeBans = new Map(); // userId -> { timestamp, createdAt } when ban expires

// Start memory cleanup service
startMemoryCleanup(buttonCooldowns, dodgeBans, matches, voteUpdateQueues);

function getQueue(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const key = `${guildId}-${channelName}`;
  if (!queues.has(key)) queues.set(key, new Set());
  return queues.get(key);
}

function getQueueLock(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const key = `${guildId}-${channelName}`;
  if (!queueLocks.has(key)) queueLocks.set(key, { locked: false });
  return queueLocks.get(key);
}

// Acquire lock for queue operations to prevent race conditions
async function acquireQueueLock(guildId, channelName = QUEUE_CHANNEL_NAME) {
  const lock = getQueueLock(guildId, channelName);
  while (lock.locked) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  lock.locked = true;
  return () => { lock.locked = false; }; // Returns unlock function
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
  await ensureCurrentQueueMessage(client, guild, getQueue);
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

  // Ping all players in the newly created match channel
  try {
    const mentions = playerIds.map(id => `<@${id}>`).join(' ');
    await textChannel.send({ content: `Match created. ${mentions}` });
  } catch {}

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
      const user = await getCachedUser(id);
      const points = user?.points || 1000;
      const member = await guild.members.fetch(id);
      // Use username only, not displayName (which might include points already)
      const name = member.user.username;
      playersList += `${points} - ${name}\n`;
    } catch (err) {
      playersList += `1000 - <@${id}>\n`;
    }
  }

  const components = await buildPickRows(guild, channel.id, state);
  return { embeds: [embed], components };
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
      const cached = await getCachedUser(uid);
      if (cached?.username) {
        label = cached.username;
      } else {
        const m = await guild.members.fetch(uid);
        label = m.user?.username || m.displayName || uid;
      }
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
      const user = await getCachedUser(uid);
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
        const user = await getCachedUser(wid);
        if (user) await syncPlayerRank(guild, wid, user.points);
      }
      for (const lid of losers) {
        const user = await getCachedUser(lid);
        if (user) await syncPlayerRank(guild, lid, user.points);
      }

      // Invalidate cache for all players after match finalization
      invalidateUserCache([...winners, ...losers]);

      state.finalized = true;
    }

    const gameId = channel.name.split("-")[0];
    const winnerTeamName = winnerKey === "A" ? "Team A" : "Team B";
    const loserTeamName = winnerKey === "A" ? "Team B" : "Team A";

    let resultsMsg = `**Game ${gameId} — Results**\n`;
    resultsMsg += `Map: ${state.selectedMap}\n`;
    resultsMsg += `Queue: General Queue V3\n\n`;
    resultsMsg += `**Winner Team: (${winnerTeamName})**\n`;
    for (const wid of winners) {
      const user = await getCachedUser(wid);
      const after = user?.points || (beforeStats[wid]?.points || 1000) + POINTS_WIN;
      const before = beforeStats[wid]?.points || 1000;
      const delta = after - before;
      const displayDelta = delta >= 0 ? `[+${delta}]` : `[${delta}]`;
      const displayName = user?.username || `${wid}`;
      resultsMsg += `<@${wid}> — ${displayName} ${before} ⟶ ${after} ${displayDelta}\n`;
    }
    resultsMsg += `\n**Loser Team: (${loserTeamName})**\n`;
    for (const lid of losers) {
      const user = await getCachedUser(lid);
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

// Interaction deduplication to prevent double processing
const processedInteractions = new Set();
setInterval(() => {
  processedInteractions.clear(); // Clear every 5 minutes
}, 5 * 60 * 1000);

export function setupQueue(client) {
  // Setup admin commands
  setupAdminCommands(client, dodgeBans, matches, voteUpdateQueues);
  
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Deduplicate: skip if already processed (only for actual duplicates from Discord)
      if (processedInteractions.has(interaction.id)) {
        console.log(`Duplicate interaction blocked: ${interaction.id}`);
        return;
      }
      
      // Mark as processed immediately to prevent double-processing
      processedInteractions.add(interaction.id);
      
      // Helper to respond safely to button interactions (handles already-acknowledged cases)
      const safeEphemeral = async (content) => {
        try {
          if (interaction.deferred) {
            return await interaction.editReply({ content });
          }
          if (interaction.replied) {
            return await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
          }
          return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        } catch (e) {
          // Swallow common Discord interaction race errors; log others
          if (e?.code !== 10062 && e?.code !== 40060) {
            console.error('Queue interaction reply error:', e);
          }
        }
      };

      // Handle button interactions
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
        
        // Anti-spam cooldown check (BEFORE setting cooldown to prevent race)
        const lastClick = buttonCooldowns.get(memberId);
        const now = Date.now();
        if (lastClick && (now - lastClick.timestamp) < BUTTON_COOLDOWN) {
          const timeLeft = Math.ceil((BUTTON_COOLDOWN - (now - lastClick.timestamp)) / 1000);
          await safeEphemeral(`Please wait ${timeLeft}s before clicking again.`);
          return;
        }
        
        // Defer after validation to prevent timeout on game creation
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        
        // Set cooldown AFTER validation but BEFORE processing
        buttonCooldowns.set(memberId, { timestamp: now, createdAt: now });
        
        const q = getQueue(guildId, channelName);

        if (interaction.customId === "queue_join") {
          const q = getQueue(guildId, channelName);
          
          // Acquire lock to prevent race condition on queue check/add
          const unlockQueue = await acquireQueueLock(guildId, channelName);
          try {
            // SIMPLE: Check if already in queue - if yes, reject. If no, allow if passes checks.
            if (q.has(memberId)) {
              console.log(`[Queue] Player ${memberId} already in ${channelName}. Queue: ${[...q].join(', ')}`);
              await safeEphemeral("You already in queue.");
              return;
            }
            
            // Not in queue yet - check if allowed to join
            const otherQueue = isUserInOtherQueue(memberId, channelName, guildId);
            if (otherQueue) {
              console.log(`[Queue] Player ${memberId} already in ${otherQueue}`);
              await safeEphemeral(`You are already in the ${otherQueue} queue. Please leave it first.`);
              return;
            }
            
            const requiredRoles = QUEUE_ROLES[channelName];
            if (requiredRoles && requiredRoles.length > 0) {
              const hasRole = interaction.member.roles.cache.some(r => requiredRoles.includes(r.name.toLowerCase()));
              if (!hasRole) {
                await safeEphemeral(`You need one of these roles to join: ${requiredRoles.join(', ')}.`);
                return;
              }
            }
            
            if (isUserDodgeBanned(memberId)) {
              const timeLeft = getDodgeBanTimeLeft(memberId);
              await safeEphemeral(`You are banned from queue for ${timeLeft} more minutes (dodged a match).`);
              return;
            }
            
            if (isUserInActiveMatch(memberId)) {
              await safeEphemeral("You already in game.");
              return;
            }
            
            // All checks passed - add to queue
            q.add(memberId);
            console.log(`[Queue] ✓ Player ${memberId} JOINED ${channelName}. Queue size: ${q.size}/${QUEUE_SIZE}. Members: ${[...q].join(', ')}`);
            await safeEphemeral("You joined the queue.");
          } finally {
            unlockQueue();
          }
        } else {
          // Leave queue
          const unlockQueue = await acquireQueueLock(guildId, channelName);
          try {
            if (!q.has(memberId)) {
              console.log(`[Queue] Player ${memberId} not in queue ${channelName}`);
              await safeEphemeral("You are not in the queue.");
              return;
            }
            q.delete(memberId);
            console.log(`[Queue] ✓ Player ${memberId} LEFT ${channelName}. Queue size: ${q.size}/${QUEUE_SIZE}. Members: ${[...q].join(', ')}`);
            await safeEphemeral("You left the queue.");
          } finally {
            unlockQueue();
          }
        }

        await updateQueueMessage(client, guild, channelName);
        scheduleCurrentQueueUpdate(client, guild, getQueue);

        // Acquire lock to prevent race conditions when creating game
        if (q.size >= QUEUE_SIZE && process.env.SIM_MODE !== '1') {
          const unlock = await acquireGameCreationLock(guildId, channelName);
          try {
            // Re-check queue size after acquiring lock (another request might have taken players)
            if (q.size >= QUEUE_SIZE) {
              const players = [...q].slice(0, QUEUE_SIZE);
              for (const id of players) q.delete(id);
              await updateQueueMessage(client, guild, channelName);
              scheduleCurrentQueueUpdate(client, guild, getQueue);
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
          await safeEphemeral("Draft not active here.");
          return;
        }
        
        // Defer after validation to prevent timeout on DB operations
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        const pickerId = interaction.user.id;
        if (state.phase === "A1" && pickerId !== state.captainA) {
          await safeEphemeral("Not your turn (Captain A picks first).");
          return;
        }
        if ((state.phase === "B1" || state.phase === "B2") && pickerId !== state.captainB) {
          await safeEphemeral("Not your turn (Captain B picking).");
          return;
        }
        if (!state.remaining.has(pickedId)) {
          await safeEphemeral("Player already picked or invalid.");
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

        await safeEphemeral("Pick enregistré.");
        return;
      }

      if (interaction.customId.startsWith("ban:")) {
        const [, channelId, mapName] = interaction.customId.split(":");
        if (interaction.channelId !== channelId) return;
        const state = matches.get(channelId);
        if (!state || state.phase !== "BAN_A" && state.phase !== "BAN_B") {
          await safeEphemeral("Bans not active now.");
          return;
        }
        
        // Defer after validation to prevent timeout on map selection
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        
        const bannerId = interaction.user.id;
        if (state.phase === "BAN_A" && bannerId !== state.captainA) {
          await safeEphemeral("Not your turn (Captain A bans first).");
          return;
        }
        if (state.phase === "BAN_B" && bannerId !== state.captainB) {
          await safeEphemeral("Not your turn (Captain B bans now).");
          return;
        }
        if (!state.availableMaps.includes(mapName)) {
          await safeEphemeral("Map already banned or invalid.");
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
        await safeEphemeral("Ban enregistré.");
        return;
      }

      if (interaction.customId.startsWith("vote:")) {
        const [, channelId, teamKey] = interaction.customId.split(":");
        if (interaction.channelId !== channelId) return;
        const state = matches.get(channelId);
        if (!state || !state.matchId) {
          await safeEphemeral("Voting not available.");
          return;
        }
        
        // Defer after validation to prevent timeout on finalization
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
        
        const voterId = interaction.user.id;
        if (!state.players.has(voterId)) {
          await safeEphemeral("Only match players can vote.");
          return;
        }
        const voteForTeamId = teamKey === "A" ? state.teamAId : state.teamBId;
        const existing = await Vote.findOne({ where: { matchId: state.matchId, voterDiscordId: voterId } });
        if (existing) {
          await existing.update({ voteForTeamId }).catch(() => {});
          await safeEphemeral("Vote updated.");
        } else {
          await Vote.create({ matchId: state.matchId, voterDiscordId: voterId, voteForTeamId });
          await safeEphemeral("Vote counted.");
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
      // (Removed duplicate /dodge handler)
    } catch (err) {
      console.error("Queue interaction error", err);
      if (!interaction.replied && !interaction.deferred) {
        try { await interaction.reply({ content: "Error handling queue action.", flags: MessageFlags.Ephemeral }); } catch {}
      }
    }
  });
}

export { getRankByPoints, syncPlayerRank, getQueue };
