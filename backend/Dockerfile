FROM node:20.19.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
COPY backend ./backend
RUN npm run build -w backend

FROM node:20.19.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
USER node
EXPOSE 5000
CMD ["npm", "run", "start", "-w", "backend"]
