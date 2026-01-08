/**
 * Rate limiter with sliding window algorithm
 * Prevents exceeding Discord API rate limits
 */
export class RateLimiter {
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

// Pre-configured rate limiters for different API call types
export const syncPlayerRankLimiter = new RateLimiter(10, 1000); // 10 per second
export const userUpdateLimiter = new RateLimiter(15, 1000); // 15 per second (less restrictive)
export const messageLimiter = new RateLimiter(20, 1000); // 20 per second (message sends)
