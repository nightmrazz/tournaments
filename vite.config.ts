/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // .env files with keys live in private/ (git-ignored). Vercel/Railway pass variables directly.
  envDir: 'private',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Guarantee a single React instance (two copies cause "Invalid hook call" and a blank page).
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5173, strictPort: true },
  // `npm start` serves the built app with `vite preview` (used on Railway). Extra hosts can be
  // allowed with PREVIEW_ALLOWED_HOSTS=host1,host2 (e.g. a custom domain).
  preview: {
    allowedHosts: ['.up.railway.app', ...(process.env.PREVIEW_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])],
  },
  build: {
    rolldownOptions: {
      output: {
        // Long-lived vendor chunks cache well between deployments.
        codeSplitting: {
          groups: [
            { name: 'supabase', test: /node_modules[\\/]@supabase/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
  },
});
