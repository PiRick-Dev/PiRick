FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web

# The SQLite database lives in /data. Creating it here, owned by the unprivileged
# user, means a fresh named volume inherits the right ownership.
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Which build this is, for Admin > Connections. GitHub fills these in when it
# builds the image; a build made by hand leaves them empty. They come last so
# that a new value never undoes the cache of the steps above.
ARG PIRICK_COMMIT=""
ARG PIRICK_BUILT=""
ENV PIRICK_COMMIT=$PIRICK_COMMIT PIRICK_BUILT=$PIRICK_BUILT

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
