import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const directory = process.argv[2];
const metadata = JSON.parse(await readFile(join(directory, 'release-api.json'), 'utf8'));
const version = process.argv[3];
const source = process.argv[4];
const assert = (condition, label) => { if (!condition) throw new Error(label); };
async function digest(name, algorithm = 'sha256', encoding = 'hex') {
 const hash=createHash(algorithm);
 for await (const chunk of createReadStream(join(directory,name))) hash.update(chunk);
 return hash.digest(encoding);
}
assert(/^0\.1\.1-beta\.\d+$/u.test(version) && /^[a-f0-9]{40}$/u.test(source), 'Explicit beta version/source required');
assert(metadata.draft===true && metadata.target_commitish===source, 'Candidate must be draft and target the reviewed source');
const expected=[];
for (const architecture of ['x64','arm64']) {
 const base=`Leaflogue-${version}-${architecture}`;
 expected.push(`Leaflogue-${version}-${architecture==='x64'?'x86_64':'arm64'}.AppImage`,`${base}.tar.gz`,`${base}.build-inputs.json`,`${base}.production-audit.json`,`${base}.supply-chain.cdx.json`,`SHA256SUMS-${architecture}.txt`);
}
for (const [platform,architecture] of [['mac','arm64'],['mac','x64'],['windows','x64']]) {
 const base=`Leaflogue-${version}-${platform}-${architecture}`;
 expected.push(`${base}.${platform==='mac'?'dmg':'exe'}`,`${base}.zip`,`${base}.build-inputs.json`,`${base}.production-audit.json`,`${base}.supply-chain.cdx.json`,`SHA256SUMS-${platform}-${architecture}.txt`);
}
expected.push(`Leaflogue-Convex-${version}.tar.gz`,`Leaflogue-Convex-${version}.manifest.json`,'SHA256SUMS-convex.txt','SHA256SUMS-updates.txt');
for(const target of ['arm64','x64','mac-arm64','mac-x64','windows-x64']) {
 expected.push(`leaflogue-update-beta-${target}.json`,`leaflogue-update-beta-${target}.json.sig`);
}
assert(metadata.assets.length===expected.length,`Expected ${expected.length} assets, found ${metadata.assets.length}`);
for (const name of expected) assert(metadata.assets.some(a=>a.name===name),`Missing ${name}`);
for (const asset of metadata.assets) {
 assert(asset.name===asset.name.split('/').pop(),'Invalid asset name');
 assert((await stat(join(directory,asset.name))).size===asset.size,`Size mismatch ${asset.name}`);
 assert(asset.digest===`sha256:${await digest(asset.name)}`,`GitHub digest mismatch ${asset.name}`);
}
const covered=new Set();
for (const name of expected.filter(name=>name.startsWith('SHA256SUMS-'))) {
 for (const line of (await readFile(join(directory,name),'utf8')).trim().split('\n')) {
  const match=/^([a-f0-9]{64})\s+\*?([^/]+)$/.exec(line);
  assert(match,`Invalid checksum line ${name}`);
  assert(expected.includes(match[2]),`Unexpected checksum target ${match[2]}`);
  assert(await digest(match[2])===match[1],`Checksum mismatch ${match[2]}`);
  covered.add(match[2]);
 }
}
// Linux evidence JSON uses the independently checked GitHub SHA-256 digests.
// Its checksum manifest covers the actual installable archives.
for(const name of expected.filter(name=>/\.(?:AppImage|tar\.gz|dmg|zip|exe)$/u.test(name)||name.startsWith('leaflogue-update-')||name.endsWith('.manifest.json'))) assert(covered.has(name),`Not covered by checksum ${name}`);
const keySource=execFileSync('git',['show',`${source}:apps/desktop/src/main/update-keys.ts`],{encoding:'utf8'});
const pem=JSON.parse(/channel:\s*"beta"[\s\S]*?publicKeyPem:\s*("(?:[^"\\]|\\.)*")/.exec(keySource)[1]);
const key=createPublicKey(pem);
const keyId=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex').slice(0,16);
for(const name of expected.filter(name=>name.startsWith('leaflogue-update-')&&name.endsWith('.json'))) {
 const bytes=await readFile(join(directory,name));const manifest=JSON.parse(bytes);const sig=JSON.parse(await readFile(join(directory,`${name}.sig`),'utf8'));
 assert(sig.keyId===keyId && verify(null,bytes,key,Buffer.from(sig.signature,'base64')),`Untrusted signature ${name}`);
 assert(manifest.version===version&&manifest.product==='leaflogue'&&manifest.channel==='beta'&&manifest.format===2,`Wrong feed metadata ${name}`);
 const artifact=manifest.artifact;
 const expectedName=manifest.platform==='linux'?`Leaflogue-${version}-${manifest.architecture==='x64'?'x86_64':'arm64'}.AppImage`:`Leaflogue-${version}-${manifest.platform}-${manifest.architecture}.${manifest.platform==='mac'?'zip':'exe'}`;
 assert(artifact.name===expectedName && expected.includes(artifact.name),`Wrong payload ${name}`);
 assert((await stat(join(directory,artifact.name))).size===artifact.size,`Payload size mismatch ${name}`);
 assert(await digest(artifact.name,'sha512','base64')===artifact.sha512,`Payload hash mismatch ${name}`);
}
for(const name of expected.filter(name=>name.endsWith('.production-audit.json'))) {
 const audit=JSON.parse(await readFile(join(directory,name),'utf8'));
 assert(audit.metadata?.vulnerabilities?.high===0&&audit.metadata?.vulnerabilities?.critical===0,`Production vulnerabilities ${name}`);
}
for(const name of expected.filter(name=>name.endsWith('.supply-chain.cdx.json'))) {
 const bom=JSON.parse(await readFile(join(directory,name),'utf8'));
 assert(bom.bomFormat==='CycloneDX'&&bom.components?.length>0,`Invalid SBOM ${name}`);
}
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const lockBytes=execFileSync('git',['show',`${source}:package-lock.json`]);
const desktopBytes=execFileSync('git',['show',`${source}:apps/desktop/package.json`]);
const lockHash=sha(lockBytes);
const desktopHash=sha(desktopBytes);
const windowsHash=(bytes)=>sha(Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')));
for(const name of expected.filter(name=>name.endsWith('.build-inputs.json'))) {
 const input=JSON.parse(await readFile(join(directory,name),'utf8'));
 assert(input.version===version,`Wrong version ${name}`);
 if(input.platform) assert(input.commit===source,`Wrong native commit ${name}`);
 else assert(input.schemaVersion===1&&input.productName==='Leaflogue',`Invalid Linux evidence ${name}`);
 const lockHashes=input.platform==='windows'?[lockHash,windowsHash(lockBytes)]:[lockHash];
 const desktopHashes=input.platform==='windows'?[desktopHash,windowsHash(desktopBytes)]:[desktopHash];
 assert(lockHashes.includes(input.lockfileSha256)&&desktopHashes.includes(input.desktopManifestSha256),`Wrong build inputs ${name}`);
}
const backend=JSON.parse(await readFile(join(directory,`Leaflogue-Convex-${version}.manifest.json`),'utf8'));
assert(backend.version===version,'Wrong backend version');
const result={version,source,assets:expected.length,githubDigests:'passed',checksums:'passed',signedBetaFeeds:5,payloadHashes:'passed',productionAudits:'no high or critical findings',sboms:5,buildInputs:'exact tagged source',verifiedAt:new Date().toISOString()};
await writeFile(join(directory,'verification-result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
