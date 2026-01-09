FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/

# Copy .env file if needed (or set via environment variables)
COPY .env .env

# Start the bot
CMD ["npm", "start"]
