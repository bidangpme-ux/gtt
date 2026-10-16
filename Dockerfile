# ===================================================
# Dockerfile E-PMPED Bapperida Tanggamus untuk CasaOS / Linux
# Menggunakan Debian-based (node:20-slim) untuk kompatibilitas
# penuh glibc dengan Vite & Rolldown native binding
# ===================================================
FROM node:20-slim

WORKDIR /app

# Copy dependency definition
COPY package.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy application source code
COPY . .

# Build frontend production bundle
RUN npm run build

# Ensure persistent data folder exists
RUN mkdir -p /app/data

VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV APP_URL=https://pme.cloudpme.my.id
ENV NEXTCLOUD_URL=https://drive.cloudpme.my.id
ENV NEXTCLOUD_USERNAME=casaos
ENV NEXTCLOUD_APP_PASSWORD=DDTRH-SQzAg-xfRCs-KK8TT-Laaaw
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.request({host: '127.0.0.1', port: 3000, path: '/', timeout: 2000}, (res) => process.exit(res.statusCode < 500 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end();"

CMD ["npx", "tsx", "server.ts"]
