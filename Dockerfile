FROM node:20-alpine

WORKDIR /app

# Таймзона для корректного тайминга подачи
RUN apk add --no-cache tzdata

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

CMD ["node", "src/index.js"]
