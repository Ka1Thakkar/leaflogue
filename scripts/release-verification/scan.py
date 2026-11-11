import json,shutil,subprocess,sys,tarfile,zipfile
from pathlib import Path
assets=Path(sys.argv[1]); dest=Path('/tmp/leaflogue-beta3-final-artifact-scan'); dest.mkdir(exist_ok=True)
asar=str(Path.cwd()/'node_modules/.bin/asar');scanner='/tmp/gitleaks/gitleaks'
def copy_sidecar(name,prefix,source,stage):
 relative=Path(name[len(prefix):]);assert not relative.is_absolute() and '..' not in relative.parts
 output=stage/'app.asar.unpacked'/relative;output.parent.mkdir(parents=True,exist_ok=True)
 with source,output.open('wb') as target:shutil.copyfileobj(source,target)
results=[]
for platform,ext in [('mac-arm64','zip'),('mac-x64','zip'),('windows-x64','zip'),('x64','tar.gz'),('arm64','tar.gz')]:
 package=assets/f'Leaflogue-0.1.1-beta.3-{platform}.{ext}';stage=dest/platform;stage.mkdir(exist_ok=True);archive=stage/'app.asar'
 if ext=='zip':
  with zipfile.ZipFile(package) as z:
   matches=[n for n in z.namelist() if n.endswith('/resources/app.asar') or n.endswith('/Resources/app.asar') or n=='resources/app.asar'];assert len(matches)==1
   with z.open(matches[0]) as source,archive.open('wb') as target:shutil.copyfileobj(source,target)
   prefix=matches[0]+'.unpacked/'
   for entry in z.infolist():
    if entry.filename.startswith(prefix) and not entry.is_dir():copy_sidecar(entry.filename,prefix,z.open(entry),stage)
 else:
  with tarfile.open(package,'r:gz') as t:
   matches=[m for m in t.getmembers() if m.name.endswith('/resources/app.asar')];assert len(matches)==1
   with t.extractfile(matches[0]) as source,archive.open('wb') as target:shutil.copyfileobj(source,target)
   prefix=matches[0].name+'.unpacked/'
   for entry in t.getmembers():
    if entry.name.startswith(prefix) and entry.isfile():copy_sidecar(entry.name,prefix,t.extractfile(entry),stage)
 source=stage/'source';subprocess.run([asar,'extract',str(archive),str(source)],check=True)
 assert json.loads((source/'package.json').read_text())['version']=='0.1.1-beta.3', 'Wrong packaged version'
 if platform in ['mac-arm64','mac-x64','windows-x64']:
  import hashlib
  evidence=json.loads((assets/f'Leaflogue-0.1.1-beta.3-{platform}.build-inputs.json').read_text())
  assert hashlib.sha256(archive.read_bytes()).hexdigest()==evidence['asarSha256'], 'Wrong packaged asar'

 r=subprocess.run([scanner,'dir','.', '--redact','--no-banner','--report-path',str(dest/f'{platform}.json')],cwd=source,capture_output=True,text=True)
 (dest/f'{platform}.log').write_text(r.stdout+r.stderr)
 results.append({'platform':platform,'scanExitCode':r.returncode});print(platform,'scan exit:',r.returncode,flush=True)
 if r.returncode:
  print(r.stdout+r.stderr,flush=True);sys.exit(r.returncode)
(dest/'results.json').write_text(json.dumps(results,indent=2)+'\n')
