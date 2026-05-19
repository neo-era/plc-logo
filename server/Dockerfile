FROM node:20-alpine
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 8080 1883 8883
CMD ["node", "server.js"]
