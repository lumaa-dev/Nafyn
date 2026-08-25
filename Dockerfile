# Dockerfile
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
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

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]