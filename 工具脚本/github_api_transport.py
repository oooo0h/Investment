"""Transport the already-reviewed Git commit through GitHub's Git database API."""
from pathlib import Path
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import re
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
STATE=ROOT/'临时文件/GitHub完整同步'
spec=importlib.util.spec_from_file_location('mirror',ROOT/'工具脚本/github_mirror.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
plan=json.loads((STATE/'plan.json').read_text(encoding='utf-8'))
expected={e['path']:e for e in plan['files']}
assert m.inventory()==expected
commit=m.git('rev-parse','HEAD')
local_tree=m.git('rev-parse','HEAD^{tree}')

def api(endpoint,body=None):
    args=['gh','api',f'repos/oooo0h/Investment/{endpoint}']
    if body is not None: args+=['-X','PATCH' if endpoint.startswith('git/refs/') else 'POST','--input','-']
    for attempt in range(3):
        p=subprocess.run(args,input=None if body is None else json.dumps(body,ensure_ascii=False).encode(),cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if p.returncode==0:break
        if not re.search(rb'HTTP (?:502|503|504)|EOF|reset|timeout',p.stderr,re.I) or attempt==2:break
        time.sleep(attempt+1)
    if p.returncode:
        status=re.search(rb'HTTP\s+(\d{3})',p.stderr)
        raise RuntimeError('GitHub API failed: '+(status[1].decode() if status else 'transport'))
    return json.loads(p.stdout)

remote=api('git/ref/heads/main')['object']['sha']
if remote==commit:
    m.verify(plan)
    raise SystemExit(0)
assert remote==plan['remote_base_commit']
old=api(f'git/trees/{remote}?recursive=1')
assert not old.get('truncated')
known={e['sha'] for e in old['tree'] if e['type']=='blob'}
entries={}
for item in subprocess.check_output(['git','ls-files','--stage','-z'],cwd=ROOT).decode().split('\0'):
    if not item: continue
    metadata,name=item.split('\t',1);mode,digest,stage=metadata.split()
    assert stage=='0' and digest==expected[name]['git_blob']
    entries[name]={'path':name,'mode':mode,'type':'blob','sha':digest}
assert set(entries)==set(expected)
new={}
for e in plan['files']:
    if e['git_blob'] not in known:new.setdefault(e['git_blob'],e)
binary=[];text=[]
for e in new.values():
    data=(ROOT/e['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest()==e['sha256']
    try:
        content=data.decode('utf-8')
        if '\0' in content: raise UnicodeDecodeError('utf-8',data,0,1,'binary')
        if len(data)>80000:binary.append(e)
        else:text.append((e,content))
    except UnicodeDecodeError:binary.append(e)

progress=STATE/'api-progress.json'
done=set(json.loads(progress.read_text(encoding='utf-8')).get('uploaded_blobs',[])) if progress.exists() else set()
def upload(e):
    data=(ROOT/e['path']).read_bytes();assert hashlib.sha256(data).hexdigest()==e['sha256']
    result=api('git/blobs',{'encoding':'base64','content':base64.b64encode(data).decode('ascii')})
    assert result['sha']==e['git_blob']
    return result['sha']
with ThreadPoolExecutor(max_workers=4) as pool:
    for digest in pool.map(upload,[e for e in binary if e['git_blob'] not in done]):
        done.add(digest);progress.write_text(json.dumps({'uploaded_blobs':sorted(done)}),encoding='utf-8')
known.update(done)
print(json.dumps({'new_binary_objects_verified':len(binary),'new_text_objects':len(text)}),flush=True)

# Start from a new tree so remote-only obsolete paths cannot survive.
initial=[e for e in entries.values() if e['sha'] in known]
batches=[];batch=[];size=0
for entry in initial:
    length=len(json.dumps(entry,ensure_ascii=False).encode())
    if batch and size+length>100000:batches.append(batch);batch=[];size=0
    batch.append(entry);size+=length
if batch:batches.append(batch)
batch=[];size=0
for e,content in text:
    aliases=[name for name,v in entries.items() if v['sha']==e['git_blob']]
    for name in aliases:
        entry={k:v for k,v in entries[name].items() if k!='sha'};entry['content']=content
        length=len(json.dumps(entry,ensure_ascii=False).encode())
        if batch and size+length>100000:batches.append(batch);batch=[];size=0
        batch.append(entry);size+=length
if batch:batches.append(batch)
tree=None
for i,batch in enumerate(batches,1):
    tree=api('git/trees',{'tree':batch,**({'base_tree':tree} if tree else {})})['sha']
    print(json.dumps({'tree_batch_verified':i,'total_batches':len(batches)}),flush=True)
assert tree==local_tree,'Remote tree serialization differs from reviewed local Git tree'
raw=subprocess.check_output(['git','cat-file','commit',commit],cwd=ROOT).decode('utf-8')
headers,message=raw.split('\n\n',1)
def identity(kind):
    match=re.search(r'^'+kind+r' (.+) <([^>]+)> (\d+) ([+-])(\d{2})(\d{2})$',headers,re.M)
    assert match
    name,email,stamp,sign,hours,minutes=match.groups()
    offset=(int(hours)*60+int(minutes))*(1 if sign=='+' else -1)
    return {'name':name,'email':email,'date':datetime.fromtimestamp(int(stamp),timezone(timedelta(minutes=offset))).isoformat()}
parents=re.findall(r'^parent ([0-9a-f]{40})$',headers,re.M)
assert parents==[remote]
created=api('git/commits',{'tree':tree,'parents':parents,'message':message,'author':identity('author'),'committer':identity('committer')})
assert created['sha']==commit,'API commit differs; branch was not updated'
assert api('git/ref/heads/main')['object']['sha']==remote,'Remote moved during transport; branch was not updated'
api('git/refs/heads/main',{'sha':commit,'force':False})
m.verify(plan)
