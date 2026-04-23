FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV ENTRIES_DIR=/data/entries

EXPOSE 3000

CMD ["node", "src/index.js"]
