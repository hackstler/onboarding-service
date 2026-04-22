FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.js --packages=external

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
