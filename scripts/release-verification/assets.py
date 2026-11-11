import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]); repo='Ka1Thakkar/leaflogue'; tag=sys.argv[2]
release=json.loads(subprocess.check_output(['gh','release','view',tag,'--repo',repo,'--json','assets,isDraft,targetCommitish,tagName']))
assert release['isDraft'], 'Candidate must remain draft until validation finishes'
assert len(release['assets'])==44, f"Unexpected assets: {len(release['assets'])}"
for asset in release['assets']:
 p=root/asset['name']; assert p.is_file(),p
 digest='sha256:'+hashlib.sha256(p.read_bytes()).hexdigest()
 assert digest==asset['digest'],f'GitHub digest mismatch: {p.name}'
checked=0
for sums in root.glob('SHA256SUMS-*.txt'):
 for line in sums.read_text().splitlines():
  if not line.strip():continue
  h,name=line.split(maxsplit=1); name=name.lstrip('*'); p=root/name
  assert p.is_file(),p
  assert hashlib.sha256(p.read_bytes()).hexdigest()==h,f'Checksum mismatch: {name}'
  checked+=1
for p in root.glob('*.production-audit.json'):
 audit=json.loads(p.read_text()); v=audit['metadata']['vulnerabilities']
 assert not v.get('high') and not v.get('critical'),p
for p in root.glob('*mac-*.build-inputs.json'):
 data=json.loads(p.read_text());assert data['commit']=='736e80e320dc59fc2ea812fa36340817c95a04e6'
for p in root.glob('*windows-*.build-inputs.json'):
 data=json.loads(p.read_text());assert data['commit']=='736e80e320dc59fc2ea812fa36340817c95a04e6'
assert (root/'Leaflogue-Convex-0.1.0-beta.3.tar.gz').is_file()
assert (root/'Leaflogue-Convex-0.1.0-beta.3.manifest.json').is_file()
print(json.dumps({'assets':len(release['assets']),'checksumListedFiles':checked,'digestVerification':'passed','highCriticalProductionAudit':'none','source':'736e80e320dc59fc2ea812fa36340817c95a04e6','tag':tag},indent=2))
