FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY game.js server.js ./
COPY public ./public
COPY data ./data-default
# przy pierwszym starcie kopiujemy przykładowe pytania do wolumenu
CMD ["sh", "-c", "[ -f data/content.json ] || (mkdir -p data && cp data-default/content.json data/); exec node server.js"]
EXPOSE 3000
