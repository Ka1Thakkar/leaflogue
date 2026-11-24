import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
const repo = 'Ka1Thakkar/leaflogue';
const tag = 'v0.1.1-beta.6';
const source = '2f57c6c';
const run = '45398502621';
const gh = (...args) => execFileSync('gh', args, {encoding:'utf8', maxBuffer: 16*1024*1024});
const status = JSON.parse(gh('run','view',run,'--repo',repo,'--json','status,conclusion,headSha'));
if (status.status !== 'completed' || !status.headSha.startsWith(source)) throw Error('Unexpected staging source');
const jobs = JSON.parse(gh('run','view',run,'--repo',repo,'--json','jobs')).jobs;
for (const name of ['Validate the exact beta source', 'mac beta (arm64)', 'mac beta (x64)', 'Linux x64 and ARM64 plus backend']) {
  if (!jobs.some(j => j.name === name && j.conclusion === 'success')) throw Error(`Missing passed job ${name}`);
}
const windowsRun = process.env.REFRESH_WINDOWS_RUN;
if (!windowsRun) throw Error('Windows repair run is required');
const windows = JSON.parse(gh('run','view',windowsRun,'--repo',repo,'--json','status,conclusion,headSha'));
if (windows.status !== 'completed' || windows.conclusion !== 'success' || !windows.headSha.startsWith('2e1f01c')) throw Error('Windows repair and signing did not pass on the expected source');
const old = JSON.parse(gh('release','view',tag,'--repo',repo,'--json','body,assets'));
mkdirSync('refresh-files');
gh('release','download','beta-candidate-44087855277-1','--repo',repo,'--dir','refresh-files');
const names = readdirSync('refresh-files').sort();
if (JSON.stringify(names) !== JSON.stringify(old.assets.map(a=>a.name).sort())) throw Error('Staged asset set differs from published release');
const bytes = name => readFileSync(`refresh-files/${name}`);
const hash = (name, algo='sha256', encoding='hex') => createHash(algo).update(bytes(name)).digest(encoding);
for (const name of names.filter(n=>n.startsWith('SHA256SUMS-'))) {
  for (const line of bytes(name).toString().trim().split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?([^/]+)$/.exec(line);
    if (!match || !names.includes(match[2]) || hash(match[2]) !== match[1]) throw Error(`Invalid checksum ${name}: ${line}`);
  }
}
const keys = readFileSync('apps/desktop/src/main/update-keys.ts','utf8');
const pem = JSON.parse(/channel:\s*"beta",\s*publicKeyPem:\s*("(?:[^"\\]|\\.)*")/.exec(keys)[1]);
const key = createPublicKey(pem);
for (const name of names.filter(n=>n.startsWith('leaflogue-update-') && n.endsWith('.json'))) {
  const manifest = JSON.parse(bytes(name));
  const sig = JSON.parse(bytes(`${name}.sig`));
  if (!verify(null, bytes(name), key, Buffer.from(sig.signature,'base64'))) throw Error(`Invalid signature ${name}`);
  const artifact = manifest.artifact ?? manifest.appImage;
  if (manifest.version !== '0.1.1-beta.6' || bytes(artifact.name).length !== artifact.size || hash(artifact.name,'sha512','base64') !== artifact.sha512) throw Error(`Invalid payload ${name}`);
}
// Upload payloads first, then checksum manifests, and signed feeds last.
for (const group of [names.filter(n=>!n.startsWith('SHA256SUMS-')&&!n.startsWith('leaflogue-update-')), names.filter(n=>n.startsWith('SHA256SUMS-')), names.filter(n=>n.startsWith('leaflogue-update-'))]) {
  gh('release','upload',tag,'--repo',repo,'--clobber',...group.map(n=>`refresh-files/${n}`));
}
const published = JSON.parse(gh('release','view',tag,'--repo',repo,'--json','assets'));
for(const asset of published.assets) if(asset.digest !== `sha256:${hash(asset.name)}`) throw Error(`Published digest mismatch ${asset.name}`);
gh('api','--method','PATCH',`repos/${repo}/git/refs/tags/${tag}`,'-f',`sha=${status.headSha}`,'-F','force=true');
let notes = old.body;
notes = notes.replace('### Compatibility and upgrades',`### Refreshed downloads — 24 November 2026\n\nRebuilt the existing beta.6 release with shelf paging (60 books per page, library-wide search), themed monochrome PDF image pages, and pre-painted adjacent PDF pages to prevent page-turn flashes. Also includes the merged reader typography, spacing, layout, appearance, and preset controls from PR #17. Reader preferences remain local to the device. The version remains 0.1.1-beta.6. Existing beta.6 users must reinstall a refreshed download because automatic updates require a newer version.\n\n### Compatibility and upgrades`);
notes = notes.replace(/### Verification[\s\S]*?(?=Guides:)/,`### Verification\n\nAll 46 refreshed assets passed checksum and published GitHub digest verification. All five beta feed signatures and payload hashes were verified against the application's trusted beta key. Background Electron workflow tests and native packaging checks passed. Windows background rendering was unthrottled in the test launcher after two runs hit the workflow test timeout; the repaired run passed all assertions. Packaged GUI boundary checks passed on the matching product source in PR #18; this rebuild uses the background launcher. Manual acceptance limits above remain.\n\nBuild: https://github.com/${repo}/actions/runs/${run}\nWindows rebuild and feed signing: https://github.com/${repo}/actions/runs/${windowsRun}\nWindows source: ${windows.headSha} (test launcher and release pipeline changes only).\nSource: ${status.headSha} (product source matches merged PR #18, e5f6094abfc73052f62f8f339474704d5889dc70; only build workflow changes differ).\n`);
writeFileSync('release-notes.txt',notes);
gh('release','edit',tag,'--repo',repo,'--target',status.headSha,'--notes-file','release-notes.txt');
console.log(`Updated ${tag}: ${names.length} verified assets; source ${status.headSha}`);
