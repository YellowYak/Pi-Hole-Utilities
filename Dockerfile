FROM node:24-slim

# Install ffmpeg, python3, and pip
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip rather than apt-get in order to get the latest & greatest
RUN pip3 install --break-system-packages yt-dlp


# Environment variables
ENV PORT=3000


WORKDIR /app

# Copy over the package.json and package-lock.json files and install!
COPY package*.json ./
RUN npm ci --omit=dev

# Copy over the germane files
COPY public/ ./public/
COPY server.js .

EXPOSE $PORT

CMD ["node", "server.js"]
