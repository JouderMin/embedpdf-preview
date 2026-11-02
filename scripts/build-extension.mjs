import { build, watch } from 'rolldown';

const watchMode = process.argv.includes('--watch');

/** @type {import('rolldown').BuildOptions} */
const options = {
  input: 'src/extension/extension.ts',
  platform: 'node',
  external: ['vscode'],
  transform: { target: 'node20' },
  output: {
    file: 'dist/extension.js',
    format: 'cjs',
    sourcemap: true,
  },
};

if (watchMode) {
  const watcher = watch(options);
  watcher.on('event', (event) => {
    if (event.code === 'ERROR') {
      console.error('[extension]', event.error);
    } else if (event.code === 'BUNDLE_END') {
      console.log(`[extension] built in ${event.duration} ms`);
      event.result.close();
    }
  });
  const stop = async () => {
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await build(options);
}
