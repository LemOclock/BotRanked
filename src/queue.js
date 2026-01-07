import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";
import { Match, Team, MatchPlayer, Vote, User } from "./models/index.js";

const QUEUE_CHANNEL_NAME = "v3-general";
const QUEUE_TAG = "[BOT-QUEUE-V1]";
const QUEUE_SIZE = 6;
const CATEGORY_GAMES = "Games";
const VOTE_TAG = "[BOT-VOTE-V1]";
const BAN_TAG = "[BOT-BAN-V1]";
const VOTE_THRESHOLD = 4;
const POINTS_WIN = Number(process.env.POINTS_WIN || 30);
const POINTS_LOSS = Number(process.env.POINTS_LOSS || 30);
const MAPS = ["Temple-M", "Old-School", "Neden-3", "Tunnel", "Colloseum", "Ziggurant", "Jungle"];
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

const queues = new Map();
const matches = new Map();

function getMapImageUrl(mapName) {
  return MAP_IMAGES[mapName] || null;
}

function getQueue(guildId) {
  if (!queues.has(guildId)) queues.set(guildId, new Set());
  return queues.get(guildId);
}

function buildQueueEmbed(guild, count) {
  return new EmbedBuilder()
    .setTitle("General Queue V3")
    .setDescription("V3, CPD, 30 minutes")
    .addFields(
      { name: "Players in queue", value: `${count}/${QUEUE_SIZE}` },
      { name: "Instructions", value: "Use the buttons to join or leave the queue." }
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
  const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === QUEUE_CHANNEL_NAME);
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = messages?.find(m => m.author?.id === client.user.id && (m.content?.includes(QUEUE_TAG) || m.embeds?.length));

  const count = getQueue(guild.id).size;
  const embed = buildQueueEmbed(guild, count);
  const row = buildQueueRow();

  if (existing) {
    try {
      await existing.edit({ content: `${QUEUE_TAG} Use buttons to join/leave.`, embeds: [embed], components: [row] });
    } catch {}
  } else {
    await channel.send({ content: `${QUEUE_TAG} Use buttons to join/leave.`, embeds: [embed], components: [row] });
  }
}

async function updateQueueMessage(client, guild) {
  return ensureQueueMessage(client, guild);
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

async function getNextGameIndex() {
  try {
    const maxId = await Match.max("id");
    return (maxId || 0) + 1;
  } catch {
    return 1;
  }
}

async function createGameChannelForSix(client, guild, playerIds) {
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_GAMES);
  if (!category) {
    category = await guild.channels.create({ name: CATEGORY_GAMES, type: ChannelType.GuildCategory });
  }

  const nextIndex = String(await getNextGameIndex()).padStart(2, "0");
  const name = `${nextIndex}-v3-general`;

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

  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const captainA = shuffled[0];
  const captainB = shuffled[1];
  const others = shuffled.slice(2);

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
    finalized: false
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

  const components = await buildPickRows(guild, channel.id, state);
  return { content: `Players: ${[...state.players].map(id => `<@${id}>`).join(" ")}`, embeds: [embed], components };
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
        await User.increment({ wins: 1 }, { where: { discordId: wid } }).catch(() => {});
        await User.increment({ points: POINTS_WIN }, { where: { discordId: wid } }).catch(() => {});
      }
      for (const lid of losers) {
        await User.increment({ losses: 1 }, { where: { discordId: lid } }).catch(() => {});
        await User.increment({ points: -POINTS_LOSS }, { where: { discordId: lid } }).catch(() => {});
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
      await channel.send({ content: resultsMsg }).catch(() => {});
      await postSelectedMapMessage(channel, state);
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
        const memberId = interaction.user.id;
        const q = getQueue(guild.id);

        if (interaction.customId === "queue_join") {
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

        await updateQueueMessage(client, guild);

        if (q.size >= QUEUE_SIZE) {
          const players = [...q].slice(0, QUEUE_SIZE);
          for (const id of players) q.delete(id);
          await updateQueueMessage(client, guild);
          await createGameChannelForSix(client, guild, players);
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
        }
        try {
          const channel = interaction.channel;
          const msg = await channel.messages.fetch(state.banMessageId).catch(() => null);
          if (state.phase === "VOTE") {
            if (msg) await msg.delete().catch(() => {});
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
          setTimeout(() => {
            try { interaction.channel.delete().catch(() => {}); } catch {}
          }, 5000);
        } else {
          await updateVoteMessage(interaction.channel, state);
        }
        return;
      }
    } catch (err) {
      console.error("Queue interaction error", err);
      if (!interaction.replied) {
        try { await interaction.reply({ content: "Error handling queue action.", flags: MessageFlags.Ephemeral }); } catch {}
      }
    }
  });
}
