FROM node:18

# Install required utilities
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    maven \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./
COPY pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install

# Copy source code
COPY . .

# Build TypeScript code
RUN pnpm build

# Set execute permissions for bash script
RUN chmod +x bash.sh

# Expose API port
EXPOSE 5000

# Start the application
CMD ["node", "dist/server.js"]