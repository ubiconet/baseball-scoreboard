import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: true,  // listen on all interfaces for tunnel access
    allowedHosts: ['scoreboard.ubiconet.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:4020',
        changeOrigin: true,
      },
      '/display': {
        target: 'http://localhost:4020',
        changeOrigin: true,
      },
      '/docs': {
        target: 'http://localhost:4020',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4020',
        changeOrigin: true,
        ws: true,  // WebSocket upgrade for Socket.io
      },
    },
  },
});
