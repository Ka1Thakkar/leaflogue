import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {verifyUpdateManifest} from '/tmp/leaflogue-beta2-runtime-verifier.mjs';
const directory=process.argv[2];
const source=readFileSync('apps/desktop/src/main/update-keys.ts','utf8');
const entries=[...source.matchAll(/channel:\s*"(stable|beta)"[\s\S]*?publicKeyPem:\s*("(?:[^"\\]|\\.)*")/g)];
const trustedKeys=entries.map(m=>({channel:m[1],publicKeyPem:JSON.parse(m[2])}));
const manifests=readdirSync(directory).filter(x=>/^leaflogue-update-beta-.*\.json$/.test(x));
if(manifests.length!==5)throw Error('Expected five beta manifests');
for(const name of manifests){
 const raw=JSON.parse(readFileSync(directory+'/'+name));
 const {manifest}=verifyUpdateManifest({manifestBytes:readFileSync(directory+'/'+name),signatureBytes:readFileSync(directory+'/'+name+'.sig'),trustedKeys,channel:'beta',platform:raw.platform,architecture:raw.architecture,currentVersion:'0.1.1-beta.2'});
 if(manifest.version!=='0.1.1-beta.2')throw Error('Wrong version');
 const hash=createHash('sha512');let size=0;
 for await(const chunk of createReadStream(directory+'/'+manifest.artifact.name)){hash.update(chunk);size+=chunk.length;}
 if(size!==manifest.artifact.size||hash.digest('base64')!==manifest.artifact.sha512)throw Error('Signed artifact mismatch');
 console.log('Verified signature and payload:',name);
}
