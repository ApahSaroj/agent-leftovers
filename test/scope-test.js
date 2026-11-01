'use strict';
// v0.4.1: a delete only clears the same-named resource in the same project/account/region.
const assert = require('assert');
const { scan } = require('../src/scan');

const ev = (command, n, session = 's1') => ({ kind: 'cmd', command, time: new Date(Date.UTC(2026, 10, 1, 1, n)).toISOString(), cwd: '/x', session, tool: 'claude' });
const st = (r) => r.resources.map((f) => `${f.name}@${(f.scope && (f.scope.project || f.scope.profile || f.scope.subscription)) || '-'}${f.scope && f.scope.region ? '/' + f.scope.region : ''}:${f.status}`).sort();

module.exports = (t) => {
  t('GCP: delete in project A leaves "web" in project B open', () => {
    const r = scan([
      ev('gcloud compute instances create web --project A --zone us-central1-a', 0),
      ev('gcloud compute instances create web --project B --zone us-central1-a', 1),
      ev('gcloud compute instances delete web --project A --zone us-central1-a', 2),
    ]);
    assert.deepStrictEqual(st(r), ['web@A:cleaned', 'web@B:left']);
  });
  t('GCP: project set by gcloud config set project counts too', () => {
    const r = scan([
      ev('gcloud compute instances create web --project A --zone us-central1-a', 0),
      ev('gcloud compute instances create web --project B --zone us-central1-a', 1),
      ev('gcloud config set project A', 2),
      ev('gcloud compute instances delete web --zone us-central1-a', 3),
    ]);
    assert.deepStrictEqual(st(r), ['web@A:cleaned', 'web@B:left']);
  });
  t('AWS: delete in one region leaves the other region open', () => {
    const r = scan([
      ev('aws s3 mb s3://logs-x --region us-east-1', 0),
      ev('aws s3 mb s3://logs-x --region eu-west-1', 1),
      ev('aws s3 rb s3://logs-x --region us-east-1', 2),
    ]);
    const left = r.resources.filter((f) => f.status === 'left');
    assert.strictEqual(left.length, 1, JSON.stringify(st(r)));
  });
  t('unknown scope on either side still matches (old behaviour)', () => {
    const r = scan([
      ev('gcloud compute instances create web --zone us-central1-a', 0),
      ev('gcloud compute instances delete web --project A --zone us-central1-a', 1),
    ]);
    assert.deepStrictEqual(r.resources.map((f) => f.status), ['cleaned']);
  });
  t('EC2 count label is not flagged as an unsafe name', () => {
    const r = scan([ev('aws ec2 run-instances --image-id ami-1 --instance-type t3.large --region us-west-2', 0)]);
    assert.ok(!/run as code/.test(r.resources[0].note || ''), r.resources[0].note);
  });
};
