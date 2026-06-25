FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

# Copy the generic runner — NO handler.js baked in.
# The container manager injects handler.js at runtime via docker exec.
COPY runner.js .

ENV HANDLER_PATH=/tmp/handler.js

EXPOSE 4000

CMD ["node", "runner.js"]
