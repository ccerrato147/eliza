# Use a single stage since we don't need to build
FROM node:22-slim
WORKDIR /app

# Install build dependencies needed for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

# Copy package files
COPY core/package.json ./

# Install all dependencies (including ts-node and other dev dependencies)
RUN pnpm install

# Copy source code and configs
COPY core/src ./src
COPY core/tsconfig.json ./
COPY core/tsconfig.build.json ./

# Create ephemeral directories
RUN mkdir -p tweetcache logs content_cache debug_audio

# Container configuration
ENV NODE_ENV=production
EXPOSE 8080

# Run the application using ts-node
CMD ["node", "--loader", "ts-node/esm", "src/index.ts"]