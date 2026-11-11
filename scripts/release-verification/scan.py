import json,shutil,subprocess,sys,tarfile,zipfile
from pathlib import Path
assets=Path(sys.argv[1]); dest=Path('/tmp/leaflogue-beta3-final-artifact-scan'); dest.mkdir(exist_ok=True)
asar=str(Path.cwd()/'node_modules/.bin/asar')
scanner='/tmp/gitleaks/gitleaks'
results=[]
for platform,ext in [('mac-arm64','zip'),('mac-x64','zip'),('windows-x64','zip'),('x64','tar.gz'),('arm64','tar.gz')]:
 package=assets/f'Leaflogue-0.1.0-beta.3-{platform}.{ext}'
 stage=dest/platform;stage.mkdir(exist_ok=True)
 archive=stage/'app.asar'
 if ext=='zip':
  with zipfile.ZipFile(package) as z:
   matches=[n for n in z.namelist() if n.endswith('/resources/app.asar') or n.endswith('/Resources/app.asar') or n=='resources/app.asar']
   assert len(matches)==1,(package,matches)
   with z.open(matches[0]) as source,archive.open('wb') as target:shutil.copyfileobj(source,target)
 else:
  with tarfile.open(package,'r:gz') as t:
   matches=[m for m in t.getmembers() if m.name.endswith('/resources/app.asar')]
   assert len(matches)==1,(package,matches)
   with t.extractfile(matches[0]) as source,archive.open('wb') as target:shutil.copyfileobj(source,target)
 source=stage/'source'
 subprocess.run([asar,'extract',str(archive),str(source)],check=True)
 report=dest/f'{platform}.json'
 r=subprocess.run([scanner,'dir','.', '--redact','--no-banner','--report-path',str(report)],cwd=source,capture_output=True,text=True)
 (dest/f'{platform}.log').write_text(r.stdout+r.stderr)
 results.append({'platform':platform,'scanExitCode':r.returncode,'report':str(report)})
 print(platform,'scan exit:',r.returncode,flush=True)
 if r.returncode:sys.exit(r.returncode)
(dest/'results.json').write_text(json.dumps(results,indent=2)+'\n')
