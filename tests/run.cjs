// Runs every tests/*.test.cjs file. Usage: npm test [-- filter]
const fs = require('fs');
const path = require('path');
const { chromium, startServer } = require('./lib.cjs');

(async () => {
  const filter = process.argv[2] || '';
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.cjs') && f.includes(filter)).sort();
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const file of files) {
    const tests = require(path.join(__dirname, file));
    for (const [name, fn] of Object.entries(tests)) {
      const t0 = Date.now();
      try {
        const res = await fn({ browser, baseUrl });
        if (res === 'skip') { skipped++; console.log(`  - ${file} › ${name} (skipped)`); continue; }
        passed++;
        console.log(`  ✓ ${file} › ${name} (${Date.now() - t0} ms)`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${file} › ${name}\n      ${err.message.split('\n').join('\n      ')}`);
      }
    }
  }
  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
