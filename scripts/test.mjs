import { spawnSync } from 'node:child_process';
import process from 'node:process';

const suites = [
  ['packages/vendor-client', [
    'dist/core/breaker.test.js',
    'dist/core/classifier.test.js',
    'dist/core/executor.test.js',
    'dist/core/interceptor.test.js',
    'dist/core/retry.test.js',
    'dist/expectations/expectations.test.js',
    'dist/vendors/vendor-contracts.test.js',
  ]],
  ['apps/worker', ['dist/jobs/jobs.test.js']],
];

for (const [cwd, files] of suites) {
  for (const file of files) {
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', file],
      {
        cwd,
        env: { PATH: process.env.PATH },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
