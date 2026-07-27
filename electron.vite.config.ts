import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@server': resolve(__dirname, 'src/server'),
        '@brain': resolve(__dirname, 'src/server/brain'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          avatar: resolve(__dirname, 'src/preload/avatar.ts'),
          chat: resolve(__dirname, 'src/preload/chat.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          menu: resolve(__dirname, 'src/preload/menu.ts'),
          permission: resolve(__dirname, 'src/preload/permission.ts'),
          imageOverlay: resolve(__dirname, 'src/preload/imageOverlay.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          avatar: resolve(__dirname, 'src/renderer/avatar/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          menu: resolve(__dirname, 'src/renderer/menu/index.html'),
          permission: resolve(__dirname, 'src/renderer/permission/index.html'),
          imageOverlay: resolve(__dirname, 'src/renderer/imageOverlay/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});
