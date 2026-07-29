FROM node:20.18.1-slim

# Every production guard in the app is gated on NODE_ENV (the JWT_SECRET boot
# check, the DB TLS warning). Render does NOT inject it for Docker-runtime
# services, so without this the guards silently no-op in production.
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p uploads

EXPOSE 7860

# --use-system-ca matches package.json's start script so the system CA store is
# available for the database TLS connection.
CMD ["node", "--use-system-ca", "index.js"]
