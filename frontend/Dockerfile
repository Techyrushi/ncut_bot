FROM node:20.19.0-alpine AS build
WORKDIR /app
ARG VITE_API_URL=https://ncut-api.ssdit.in/api/v1
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
COPY frontend ./frontend
RUN npm run build -w frontend

FROM nginx:1.27.3-alpine AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
