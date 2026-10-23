# Dockerfile
FROM node:22-alpine AS build
WORKDIR /app

# package-lock.json too, so the build installs the versions the project was tested with
COPY package.json package-lock.json* ./
RUN npm install -g npm@latest && npm install

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# chromaprint provides fpcalc, needed by server/utils/fingerprint.ts to verify downloads against AcoustID;
# ca-certificates is required for outbound HTTPS (AcoustID/MusicBrainz/Last.fm) to trust valid certs
RUN apk add --no-cache chromaprint ca-certificates

COPY --from=build /app/.output ./.output

# the server doesn't need root. It writes under /app/.data (temp files, cover cache) and /app/music; when those
# are bind-mounted, the host directories have to be writable by uid 1000 (the `node` user).
RUN mkdir -p /app/.data /app/music && chown -R node:node /app
USER node

EXPOSE 3000

# the root redirects (302) to the library; any answer at all means the server is up
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT:-3000}/ || exit 1

CMD ["node", ".output/server/index.mjs"]