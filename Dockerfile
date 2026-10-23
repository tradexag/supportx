# SupportX – one image for web/API and worker (different commands).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Dev dependencies are needed at runtime in 0.1 (tsx runs the TypeScript sources; vite builds the UI).
RUN npm ci --include=dev
COPY . .
RUN npm run build:web
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/server/main.ts"]
