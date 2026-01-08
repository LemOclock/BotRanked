import { User } from "../models/index.js";

const userCache = new Map(); // discordId -> { user, timestamp }
const CACHE_TTL = 10000; // 10 seconds

/**
 * Get user from cache or database
 * @param {string} discordId - Discord user ID
 * @returns {Promise<User|null>}
 */
export async function getCachedUser(discordId) {
  const cached = userCache.get(discordId);
  
  // Return cached if exists and not expired
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.user;
  }
  
  // Fetch from database
  const user = await User.findOne({ where: { discordId } });
  
  // Store in cache
  if (user) {
    userCache.set(discordId, { 
      user, 
      timestamp: Date.now() 
    });
  }
  
  return user;
}

/**
 * Get multiple users from cache or database
 * @param {string[]} discordIds - Array of Discord user IDs
 * @returns {Promise<User[]>}
 */
export async function getCachedUsers(discordIds) {
  const users = [];
  const uncachedIds = [];
  
  // Check cache first
  for (const id of discordIds) {
    const cached = userCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      users.push(cached.user);
    } else {
      uncachedIds.push(id);
    }
  }
  
  // Fetch uncached users from database
  if (uncachedIds.length > 0) {
    const dbUsers = await User.findAll({ where: { discordId: uncachedIds } }).catch(() => []);
    
    // Store in cache
    for (const user of dbUsers) {
      userCache.set(user.discordId, { 
        user, 
        timestamp: Date.now() 
      });
      users.push(user);
    }
  }
  
  return users;
}

/**
 * Invalidate cache for specific users (e.g., after match finalization)
 * @param {string[]} discordIds - Array of Discord user IDs to invalidate
 */
export function invalidateUserCache(discordIds) {
  for (const id of discordIds) {
    userCache.delete(id);
  }
}

/**
 * Clear entire user cache
 */
export function clearUserCache() {
  userCache.clear();
}
