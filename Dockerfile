FROM node:24-alpine AS build

WORKDIR /app
RUN npm install --global pnpm@11.19.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY server/ ./server/
COPY public/ ./public/
RUN pnpm build

FROM nginx:stable-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/nginx/html/licenses/

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# The static configuration needs no root-owned entrypoint scripts.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
