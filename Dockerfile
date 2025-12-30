FROM node:18-bullseye-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Create App Directory
WORKDIR /app

# Install Dependencies
COPY package*.json ./
RUN npm install

# Copy Source
COPY . .

# Expose Port (Render sets PORT env var automatically)
EXPOSE 3000

# Start Server
CMD ["node", "server.js"]
