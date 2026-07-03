FROM node:20.18.1-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p uploads

EXPOSE 7860

CMD ["node", "index.js"]
