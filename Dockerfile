FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
# Switch to PostgreSQL for production
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
RUN npm ci
RUN npx prisma generate
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json .
COPY --from=builder /app/prisma prisma/
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
