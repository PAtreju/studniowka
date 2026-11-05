FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production PORT=3001 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "server.js"]
