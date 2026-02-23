FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better Docker layer caching)
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Fly.io persistent volume is mounted at /data at runtime.
# Create the directory in the image as a fallback for local use.
RUN mkdir -p /data

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "server.js"]
