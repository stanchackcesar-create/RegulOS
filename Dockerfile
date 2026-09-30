FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo
ENV REGULOS_TIMEZONE=America/Sao_Paulo
ENV REGULOS_DATA_DIR=/app/storage/data
ENV REGULOS_AUTH_DIR=/app/storage/auth
ENV REGULOS_HOST=0.0.0.0
ENV REGULOS_PORT=3000

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npx playwright install --with-deps chromium

COPY . .
RUN mkdir -p /app/storage/data /app/storage/auth

EXPOSE 3000

# Use o mesmo inicializador do npm start. Ele aplica primeiro as correções
# de agendamento/grupo e só então inicia o servidor.
CMD ["node", "tools/patch_scheduled_group.js"]
