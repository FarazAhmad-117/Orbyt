# Build from the repo root: docker build -f docker/web.Dockerfile .
# shortcut: single stage, no Next "standalone" output; switch to standalone when image size matters.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile --filter "@orbyt/web..."
RUN pnpm --filter "@orbyt/web..." build
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@orbyt/web", "start"]
