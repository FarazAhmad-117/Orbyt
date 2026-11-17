# Build from the repo root: docker build -f docker/api.Dockerfile .
# shortcut: single stage, devDependencies stay in the image; split into build/runtime stages
# (or `pnpm deploy`) when image size matters.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile --filter "@orbyt/api..."
RUN pnpm --filter "@orbyt/api..." build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["pnpm", "--filter", "@orbyt/api", "start"]
