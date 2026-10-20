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
        category='remote_changed' if re.search(r'non-fast-forward|fetch first|stale info',error,re.I) else 'authentication' if re.search(r'HTTP\s+401|GitHub API failed:\s*401|bad credentials|gh auth login|not logged|requires authentication|authentication failed',error,re.I) else 'network' if re.search(r'reset|connect|timeout|timed out|schannel|RPC failed|TLS|EOF|HTTP\s+50[234]',error,re.I) else 'permissions' if re.search(r'denied|index.lock|permission|HTTP\s+403',error,re.I) else 'command_failed'
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

def committed_files():
    files={}
    for item in command(['git','ls-tree','-r','-z','HEAD']).split(b'\0'):
        if item:
            metadata,name=item.split(b'\t',1)
            files[name.decode('utf-8')]=metadata.split()[2].decode('ascii')
    return files

def reviewed_base(remote_commit):
    """Accept only the remote HEAD or a previously reviewed unpublished chain."""
    head=git('rev-parse','HEAD')
    if head==remote_commit:return head
    previous_path=STATE/'plan.json'
    require(previous_path.is_file(),'Local HEAD and remote main differ; reconcile before mirroring')
    previous=json.loads(previous_path.read_text(encoding='utf-8'))
    require(previous.get('schema')=='project-full-mirror-v1' and previous.get('repository')==REPOSITORY
            and previous.get('branch')=='main' and previous.get('remote_base_commit')==remote_commit,
            'Local HEAD and remote main differ; reconcile before mirroring')
    reviewed=previous.get('reviewed_local_head',remote_commit)
    if head==reviewed:
        require(previous.get('reviewed_head_tree')==git('rev-parse','HEAD^{tree}'),
                'Local HEAD and remote main differ; reconcile before mirroring')
    else:
        require(git('show','-s','--format=%P','HEAD')==reviewed
                and committed_files()=={entry['path']:entry['git_blob'] for entry in previous['files']},
                'Local HEAD and remote main differ; reconcile before mirroring')
    command(['git','merge-base','--is-ancestor',remote_commit,head])
    return head

def prepare():
    verify_context()
    STATE.mkdir(parents=True,exist_ok=True)
    files=inventory()
    commit,old=remote()
    head=reviewed_base(commit)
    plan={'schema':'project-full-mirror-v1','repository':REPOSITORY,'branch':'main','excluded_directories':['.git','临时文件'],
          'raw_account_file_authorization':'2026-10-20 user explicitly allowed public original account files',
          'remote_base_commit':commit,'reviewed_local_head':head,'reviewed_head_tree':git('rev-parse','HEAD^{tree}'),
          'files':list(files.values()),'delete_remote_paths':sorted(set(old)-set(files)),
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

def push_reviewed(plan, dry_run=False):
    """Push the exact reviewed Git history normally, without forcing updates."""
    verify_context()
    expected={e['path']:e for e in plan['files']}
    require(inventory()==expected,'Files changed after review; prepare again')
    head=git('rev-parse','HEAD')
    require(committed_files()=={p:e['git_blob'] for p,e in expected.items()},
            'Committed tree differs from reviewed file paths or bytes')
    current,_=remote()
    if current==head:
        verify(plan)
        return
    require(current==plan['remote_base_commit'],'Remote changed after review; stop')
    reviewed=plan.get('reviewed_local_head',current)
    require(head==reviewed or git('show','-s','--format=%P','HEAD')==reviewed,
            'Local HEAD and remote main differ; reconcile before mirroring')
    command(['git','merge-base','--is-ancestor',current,head])
    args=['git','-c','http.version=HTTP/1.1','-c','credential.helper=',
          '-c','credential.helper=!gh auth git-credential','push','--porcelain']
    if dry_run:args.append('--dry-run')
    print(json.dumps({'sync_stage':'push-dry-run' if dry_run else 'push'}),flush=True)
    command(args+['origin','HEAD:refs/heads/main'])
    if not dry_run:
        print(json.dumps({'sync_stage':'verify'}),flush=True)
        verify(plan)
        git('update-ref','refs/remotes/origin/main',head)

def apply():
    verify_context()
    plan=json.loads((STATE/'plan.json').read_text(encoding='utf-8'))
    require(plan['schema']=='project-full-mirror-v1' and plan['repository']==REPOSITORY,'Unexpected mirror plan')
    current=inventory()
    require(current=={e['path']:e for e in plan['files']},'Files changed after review; prepare again')
    commit,_=remote()
    require(commit==plan['remote_base_commit'] and git('rev-parse','HEAD')==plan.get('reviewed_local_head',commit),
            'Remote changed after review; stop')
    tracked=set(command(['git','ls-files','-z']).decode('utf-8').split('\0'))-{''}
    paths=sorted(set(current)|tracked)
    pathfile=STATE/'reviewed-paths.nul'; pathfile.write_bytes(b'\0'.join(p.encode('utf-8') for p in paths)+b'\0')
    print(json.dumps({'sync_stage':'stage'}),flush=True)
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
        print(json.dumps({'sync_stage':'commit'}),flush=True)
        git('commit','-m','Mirror the complete project layout and keep temporary files local')
    push_reviewed(plan)

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
