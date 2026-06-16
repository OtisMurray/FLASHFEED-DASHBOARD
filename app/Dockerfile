# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production stage ────────────────────────────────────
FROM nginx:1.26-alpine

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx config (with /api proxy)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 (Railway maps PORT to 80)
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]