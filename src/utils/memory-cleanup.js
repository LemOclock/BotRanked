/**
 * Memory cleanup service
 * Periodically removes expired data from in-memory Maps to prevent memory leaks
 */

const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const COOLDOWN_TTL = 60 * 60 * 1000; // 1 hour
const DODGE_BAN_DURATION = 60 * 60 * 1000; // 1 hour
const MATCH_TTL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Start periodic cleanup of expired data
 * @param {Map} buttonCooldowns - userId -> { timestamp, createdAt }
 * @param {Map} dodgeBans - userId -> { timestamp, createdAt }
 * @param {Map} matches - channelId -> matchState
 * @param {Map} voteUpdateQueues - matchId -> boolean
 */
export function startMemoryCleanup(buttonCooldowns, dodgeBans, matches, voteUpdateQueues) {
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
}
