"""Review, mirror and verify the complete project tree without logging contents."""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile
import io

ROOT=Path(__file__).resolve().parents[1]
STATE=ROOT/'临时文件/GitHub完整同步'
REPOSITORY='oooo0h/Investment'
EXCLUDED={'.git','临时文件'}
TOKEN=re.compile(rb'(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')

def require(condition,message):
    if not condition: raise RuntimeError(message)

def command(args, data=None):
    p=subprocess.run(args,cwd=ROOT,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                     env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_LITERAL_PATHSPECS':'1'})
    if p.returncode:
        error=p.stderr.decode('utf-8',errors='replace')
        category='authentication' if re.search(r'HTTP\s+401|GitHub API failed:\s*401|bad credentials|gh auth login|not logged|requires authentication',error,re.I) else 'network' if re.search(r'reset|connect|timeout|schannel',error,re.I) else 'permissions' if re.search(r'denied|index.lock|permission|HTTP\s+403',error,re.I) else 'command_failed'
        raise RuntimeError(f'{args[0]} failed: {category}')
    return p.stdout

def git(*args): return command(['git',*args]).decode('utf-8').strip()

def api(endpoint): return json.loads(command(['gh','api',f'repos/{REPOSITORY}/{endpoint}']).decode('utf-8'))

def blob(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()

def inspect_bytes(name,data):
    if name.endswith(('.zip','.xlsx','.xlsm')):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for item in z.infolist():
                require(item.file_size<100_000_000,'Oversized archive member; review required')
                if item.filename.lower().endswith(('.xml','.json','.csv','.js','.mjs','.txt','.md','.env')):
                    require(not TOKEN.search(z.read(item)),'Credential pattern found in archive; review required')
    else: require(not TOKEN.search(data),'Credential pattern found; review required')

def inventory(root=ROOT,scan=True):
    files={}
    for parent,dirs,names in os.walk(root,followlinks=False):
        if Path(parent)==root: dirs[:]=[d for d in dirs if d not in EXCLUDED]
        for name in dirs:
            p=Path(parent,name)
            require(not p.is_symlink() and not os.path.isjunction(p),'Unexpected directory link outside temporary folder')
        for name in names:
            p=Path(parent,name); relative=p.relative_to(root).as_posix()
            require(not p.is_symlink(),'Unexpected file link; review required')
            require(name!='.env' and not name.startswith('.env.') and name not in {'id_rsa','id_ed25519','credentials'},'Credential file outside temporary folder; review required')
            data=p.read_bytes()
            require(len(data)<95_000_000,'File exceeds reviewed GitHub size limit')
            if scan: inspect_bytes(name,data)
            files[relative]={'path':relative,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'git_blob':blob(data)}
    return files

def remote():
    commit=api('git/ref/heads/main')['object']['sha']
    tree=api(f'git/trees/{commit}?recursive=1')
    require(not tree.get('truncated'),'Remote file tree is incomplete')
    return commit,{e['path']:e['sha'] for e in tree['tree'] if e['type']=='blob'}

def verify_context():
    require((ROOT/'.git').exists(),'Local Git metadata missing; restore repository metadata before mirroring')
    require(git('remote','get-url','origin')==f'https://github.com/{REPOSITORY}.git','Unexpected Git destination')
    require(git('branch','--show-current')=='main','Unexpected local branch')
    require(not git('diff','--cached','--name-only'),'Unreviewed staged changes; stop before preparing')

def prepare():
    verify_context()
    STATE.mkdir(parents=True,exist_ok=True)
    files=inventory()
    commit,old=remote()
    require(git('rev-parse','HEAD')==commit,'Local HEAD and remote main differ; reconcile before mirroring')
    plan={'schema':'project-full-mirror-v1','repository':REPOSITORY,'branch':'main','excluded_directories':['.git','临时文件'],
          'raw_account_file_authorization':'2026-10-20 user explicitly allowed public original account files',
          'remote_base_commit':commit,'files':list(files.values()),'delete_remote_paths':sorted(set(old)-set(files)),
          'changed_paths':sorted(p for p,e in files.items() if old.get(p)!=e['git_blob'])}
    (STATE/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'reviewed_files':len(files),'changed_or_added':len(plan['changed_paths']),'old_remote_paths_to_remove':len(plan['delete_remote_paths']),'credential_scan_passed':True}))

def verify(plan):
    current=inventory()
    expected={e['path']:e for e in plan['files']}
    require(current==expected,'Local files changed after review; prepare a new plan')
    commit,tree=remote()
    wanted={p:e['git_blob'] for p,e in expected.items()}
    require(tree==wanted,'Remote paths or file hashes differ from local project')
    require(commit==git('rev-parse','HEAD'),'Remote main does not match local HEAD')
    require(not any(p.startswith('临时文件/') for p in tree),'Temporary material reached remote tree')
    result={'repository':REPOSITORY,'branch':'main','commit':commit,'verified_files':len(expected),'path_sets_equal':True,'file_hashes_equal':True,'temporary_files_uploaded':0}
    (STATE/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result))

def apply():
    verify_context()
    plan=json.loads((STATE/'plan.json').read_text(encoding='utf-8'))
    require(plan['schema']=='project-full-mirror-v1' and plan['repository']==REPOSITORY,'Unexpected mirror plan')
    current=inventory()
    require(current=={e['path']:e for e in plan['files']},'Files changed after review; prepare again')
    commit,_=remote()
    require(commit==plan['remote_base_commit']==git('rev-parse','HEAD'),'Remote changed after review; stop')
    tracked=set(command(['git','ls-files','-z']).decode('utf-8').split('\0'))-{''}
    paths=sorted(set(current)|tracked)
    pathfile=STATE/'reviewed-paths.nul'; pathfile.write_bytes(b'\0'.join(p.encode('utf-8') for p in paths)+b'\0')
    git('add','--all',f'--pathspec-from-file={pathfile}','--pathspec-file-nul')
    # Re-read old tracked entries through the current byte-preserving attributes.
    git('add','--renormalize','--','.')
    index={}
    for entry in command(['git','ls-files','--stage','-z']).decode('utf-8').split('\0'):
        if not entry: continue
        metadata,name=entry.split('\t',1); mode,digest,stage=metadata.split()
        require(stage=='0','Unmerged index entry')
        index[name]=digest
    require(index=={p:e['git_blob'] for p,e in current.items()},'Staged tree differs from reviewed file paths or bytes')
    if git('diff','--cached','--name-only'):
        git('commit','-m','Mirror the complete project layout and keep temporary files local')
    # Transfer the exact local commit through GitHub's official Git database API.
    # The transport checks the parent and tree hash, then fast-forwards with
    # force=false. This also works where Git's HTTPS endpoint is unreachable.
    output=command([sys.executable,'-X','utf8','-B',str(ROOT/'工具脚本/github_api_transport.py')])
    for line in output.decode('utf-8').splitlines():
        print(line)
    verify(plan)
    git('update-ref','refs/remotes/origin/main',git('rev-parse','HEAD'))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=['prepare','apply','verify'])
    args=parser.parse_args()
    try:
        if args.operation=='prepare': prepare()
        elif args.operation=='apply': apply()
        else: verify(json.loads((STATE/'plan.json').read_text(encoding='utf-8')))
    except Exception as e:
        print(json.dumps({'status':'stopped','reason':str(e) if isinstance(e,RuntimeError) else type(e).__name__}),file=sys.stderr)
        raise SystemExit(1)
