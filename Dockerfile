FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY client ./client
COPY index.js ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY schema.sql ./schema.sql

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
