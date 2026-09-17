const path = require('path');
const os = require('os');

const { VitePlugin } = require('@electron-forge/plugin-vite');

const projectRoot = process.cwd();
const forgeTmpDir = path.join(os.tmpdir(), 'worktrace-forge-tmp');
const worktraceIconPath = path.join(projectRoot, 'resources', 'icons', 'workboard.ico');

module.exports = {
  packagerConfig: {
    asar: true,
    icon: worktraceIconPath,
    extraResource: ['resources/workflow'],
    tmpdir: forgeTmpDir,
  },
  rebuildConfig: {},
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};
