FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/vendor-client/package.json packages/vendor-client/package.json
COPY apps/standalone/package.json apps/standalone/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/vendor-client/tsconfig.json packages/vendor-client/tsconfig.json
COPY packages/vendor-client/src packages/vendor-client/src
COPY apps/standalone/tsconfig.json apps/standalone/tsconfig.json
COPY apps/standalone/src apps/standalone/src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/vendor-client/package.json ./packages/vendor-client/package.json
COPY --from=build /app/packages/vendor-client/dist ./packages/vendor-client/dist
COPY --from=build /app/apps/standalone/package.json ./apps/standalone/package.json
COPY --from=build /app/apps/standalone/dist ./apps/standalone/dist

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/standalone/dist/server.js"]
