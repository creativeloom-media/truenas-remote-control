FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data
VOLUME /data
CMD ["node", "server.js"]
