import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    conditions: ['import'],
    extensions: ['.ts', '.js'],
  },
});
