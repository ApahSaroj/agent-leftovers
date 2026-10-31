'use strict';
// Fake gcloud / aws / supabase / vercel binaries for --verify tests.
// Each logs its argv to calls.log so tests can prove only read-only calls ran.
const fs = require('fs');
const path = require('path');

const SCRIPT = (name) => `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify('LOG')}, ${JSON.stringify(name)} + ' ' + a.join(' ') + '\\n');
const has = (s) => a.includes(s);
const out = (s) => { process.stdout.write(s + '\\n'); process.exit(0); };
const fail = (s, code = 1) => { process.stderr.write(s + '\\n'); process.exit(code); };
switch (${JSON.stringify(name)}) {
  case 'gcloud':
    if (has('llm-worker-1')) out('llm-worker-1');
    if (has('scratch-250')) fail("ERROR: (gcloud.compute.disks.describe) Could not fetch resource: The resource 'projects/p/zones/us-central1-a/disks/scratch-250' was not found");
    if (has('pdf-api')) fail('ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: caller lacks permission');
    if (has('services') && has('list')) out(a.some((x) => x.includes('aiplatform')) ? 'aiplatform.googleapis.com' : '');
    fail('ERROR: unexpected call');
    break;
  case 'aws':
    if (has('describe-instances')) out('i-0abc123\\ti-0def456');
    fail('An error occurred (AccessDenied)');
    break;
  case 'supabase':
    if (has('projects') && has('list')) out('[{"id":"qwertyref123","name":"saas-staging"}]');
    fail('unexpected');
    break;
  case 'vercel':
    if (has('inspect')) fail("Error: Can't find the deployment dpl_abc");
    fail('unexpected');
    break;
}
`;

function makeFakeBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const name of ['gcloud', 'aws', 'supabase', 'vercel']) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, SCRIPT(name).replace(JSON.stringify('LOG'), JSON.stringify(log)));
    fs.chmodSync(p, 0o755);
  }
  return log;
}

module.exports = { makeFakeBin };
