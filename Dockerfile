# Use official Node.js runtime as base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Add metadata
LABEL maintainer="lnp2pBot Team"
LABEL description="Health monitoring service for lnp2pBot"
LABEL version="1.0.0"

# Create a non-root user to run the application
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the application code
COPY . .

# Create logs directory and set permissions
RUN mkdir -p logs && chown -R nodejs:nodejs /usr/src/app

# Switch to non-root user
USER nodejs

# Expose the port the app runs on
EXPOSE 3000

# Define environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info

# Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { \
    if (res.statusCode === 200) { console.log('OK'); process.exit(0); } \
    else { console.log('FAIL'); process.exit(1); } \
  }).on('error', () => { console.log('ERROR'); process.exit(1); })"

# Start the application
CMD ["node", "server.js"]