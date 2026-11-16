FROM node:24-alpine
WORKDIR /app
COPY core ./core
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/src ./server/src
COPY server/db ./server/db
USER node
EXPOSE 3100
CMD ["node", "server/src/main.js"]
