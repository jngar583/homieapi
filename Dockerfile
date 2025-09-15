# Dockerfile
FROM mcr.microsoft.com/playwright:focal

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
